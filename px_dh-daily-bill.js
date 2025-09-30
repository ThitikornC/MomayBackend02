// server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' })); // สำหรับ dev เท่านั้น

// ================= MongoDB =================
const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
    console.error('❌ MONGODB_URI not set in .env');
    process.exit(1);
}

mongoose.connect(mongoUri, {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log('✅ Connected to MongoDB Atlas'))
.catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
});

// ================= Schema =================
const px_dh_schema = new mongoose.Schema({
    voltage: Number,
    current: Number,
    power: Number,
    active_power_phase_a: Number,
    active_power_phase_b: Number,
    active_power_phase_c: Number,
    voltage1: Number,
    voltage2: Number,
    voltage3: Number,
    voltageln: Number,
    voltagell: Number,
    timestamp: { type: Date, default: () => new Date(Date.now() + 7*60*60*1000) }, // UTC+7
}, { timestamps: true });

const PowerPXDH11 = mongoose.model("power_px_dh11", px_dh_schema);

// ================= Helper Functions =================
function calculateBill(energyKwh, ratePerKwh = 4.4) {
    return Number((energyKwh * ratePerKwh).toFixed(2));
}

// แปลง YYYY-MM-DD เป็น UTC+7 Date range
function getDayRange(dateStr) {
    const start = new Date(dateStr + "T00:00:00.000Z"); // UTC
    const end = new Date(dateStr + "T23:59:59.999Z");
    return { start, end };
}

// แปลง YYYY-MM เป็น UTC month range
function getMonthRange(yearMonth) {
    const start = new Date(`${yearMonth}-01T00:00:00.000Z`);
    const nextMonth = new Date(start);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    return { start, end: nextMonth };
}

// ================= Routes =================

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'OK',
        service: 'px_dh Daily Bill API',
        version: '1.0.4',
        timestamp: new Date().toISOString()
    });
});

// ================= Daily Bill =================
app.get('/daily-bill', async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const selectedDate = req.query.date || today;

        if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) {
            return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD', example: '2025-09-30' });
        }

        const { start, end } = getDayRange(selectedDate);

        const agg = await PowerPXDH11.aggregate([
            { $match: { timestamp: { $gte: start, $lte: end } } },
            {
                $group: {
                    _id: null,
                    totalPower: { $sum: "$power" },
                    avgPower: { $avg: "$power" },
                    maxPower: { $max: "$power" },
                    minPower: { $min: "$power" },
                    count: { $sum: 1 },
                }
            }
        ]);

        if (!agg.length) {
            return res.status(404).json({
                error: `No data found for ${selectedDate}`,
                date: selectedDate,
                total_energy_kwh: 0,
                electricity_bill: 0
            });
        }

        const result = agg[0];
        const totalEnergyKwh = Number((result.totalPower / 60).toFixed(2));
        const electricityBill = calculateBill(totalEnergyKwh);

        res.json({
            date: selectedDate,
            samples: result.count,
            total_energy_kwh: totalEnergyKwh,
            avg_power_kw: Number(result.avgPower.toFixed(2)),
            max_power_kw: Number(result.maxPower.toFixed(2)),
            min_power_kw: Number(result.minPower.toFixed(2)),
            electricity_bill: electricityBill,
            rate_per_kwh: 4.4
        });
    } catch (err) {
        console.error('❌ /daily-bill error:', err);
        res.status(500).json({ error: 'Failed to process data', message: err.message });
    }
});

// /daily-bill/:date
app.get('/daily-bill/:date', async (req, res) => {
    req.query.date = req.params.date;
    return app._router.handle(req, res);
});

// ================= Monthly Summary =================
app.get('/monthly-summary/:yearMonth', async (req, res) => {
    try {
        const yearMonth = req.params.yearMonth;
        if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
            return res.status(400).json({ error: 'Invalid month format. Use YYYY-MM', example: '2025-09' });
        }

        const { start, end } = getMonthRange(yearMonth);

        const agg = await PowerPXDH11.aggregate([
            { $match: { timestamp: { $gte: start, $lt: end } } },
            {
                $project: {
                    power: 1,
                    localDate: {
                        $dateToString: { format: "%Y-%m-%d", date: "$timestamp" }
                    }
                }
            },
            {
                $group: {
                    _id: "$localDate",
                    totalPowerSum: { $sum: "$power" },
                    count: { $sum: 1 }
                }
            },
            { $sort: { "_id": 1 } }
        ]);

        if (!agg.length) {
            return res.status(404).json({
                error: `No data found for ${yearMonth}`,
                month: yearMonth,
                daily_summary: []
            });
        }

        const dailySummary = agg.map(item => {
            const energyKwh = Number((item.totalPowerSum / 60).toFixed(2));
            return {
                date: item._id,
                samples: item.count,
                total_energy_kwh: energyKwh,
                electricity_bill: calculateBill(energyKwh)
            };
        });

        const monthTotal = dailySummary.reduce((sum, day) => sum + day.total_energy_kwh, 0);
        const monthBill = calculateBill(monthTotal);

        res.json({
            month: yearMonth,
            total_days: dailySummary.length,
            total_energy_kwh: Number(monthTotal.toFixed(2)),
            total_electricity_bill: monthBill,
            daily_summary: dailySummary
        });

    } catch (err) {
        console.error('❌ /monthly-summary error:', err);
        res.status(500).json({ error: 'Failed to get monthly summary', message: err.message });
    }
});

// ================= Monthly Calendar =================
app.get('/calendar', async (req, res) => {
    try {
        const agg = await PowerPXDH11.aggregate([
            {
                $project: {
                    power: 1,
                    localDate: {
                        $dateToString: { format: "%Y-%m-%d", date: "$timestamp" }
                    }
                }
            },
            {
                $group: {
                    _id: "$localDate",
                    totalPowerSum: { $sum: "$power" },
                    count: { $sum: 1 }
                }
            },
            { $sort: { "_id": 1 } }
        ]);

        if (!agg.length) {
            return res.status(404).json({ error: 'No data found in database' });
        }

        const events = agg.flatMap(item => {
            const energyKwh = Number((item.totalPowerSum / 60).toFixed(2));
            const bill = calculateBill(energyKwh);

            return [
                {
                    title: `${energyKwh} Unit`,
                    start: item._id,
                    extendedProps: {
                        type: 'energy',
                        samples: item.count,
                        display_text: `${energyKwh} Unit`
                    },
                   
                },
                {
                    title: `฿${bill}`,
                    start: item._id,
                    extendedProps: {
                        type: 'bill',
                        display_text: `฿${bill}`
                    },
                   
                }
            ];
        });

        res.json(events);

    } catch (err) {
        console.error('❌ /calendar error:', err);
        res.status(500).json({ error: 'Failed to get calendar data', message: err.message });
    }
});

// ================= 404 & Error Handler =================
app.use((req, res) => {
    res.status(404).json({
        error: 'Endpoint not found',
        available_endpoints: [
            'GET /',
            'GET /daily-bill?date=YYYY-MM-DD',
            'GET /daily-bill/:date',
            'GET /monthly-summary/:yearMonth',
            'GET /calendar'
        ]
    });
});

app.use((err, req, res, next) => {
    console.error('❌ Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error', message: process.env.NODE_ENV === 'development' ? err.message : undefined });
});

// ================= Graceful Shutdown =================
process.on('SIGTERM', async () => {
    console.log('🔄 SIGTERM received, closing server...');
    await mongoose.connection.close();
    process.exit(0);
});

// ================= Start Server =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/`);
});
