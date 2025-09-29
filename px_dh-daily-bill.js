const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors({ origin: '*' }));

// MongoDB Connection
const mongoUri = `mongodb+srv://nippit62:ohm0966477158@testing.hgxbz.mongodb.net/?retryWrites=true&w=majority`;

mongoose.connect(mongoUri).then(() => {
    console.log("Connected to MongoDB Atlas");
}).catch((err) => {
    console.error("MongoDB connection error:", err);
});

// Schema
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
    timestamp: { type: Date, default: () => new Date(Date.now() + (7 * 60 * 60 * 1000)) },
});

const power_px_dh11 = mongoose.model("power_px_dh11", px_dh_schema);

// Daily Bill - วันปัจจุบัน หรือระบุผ่าน query ?date=
app.get('/daily-bill', async (req, res) => {
    try {
        const selectedDate = req.query.date || new Date().toISOString().split('T')[0];
        
        const aggregationResult = await power_px_dh11.aggregate([
            {
                $match: {
                    timestamp: {
                        $gte: new Date(`${selectedDate}T00:00:00Z`),
                        $lt: new Date(`${selectedDate}T23:59:59.999Z`),
                    },
                },
            },
            {
                $group: {
                    _id: null,
                    totalPower: { $sum: "$power" },
                    count: { $sum: 1 },
                },
            },
        ]);

        if (!aggregationResult.length) {
            return res.status(404).json({ 
                error: `No data found for ${selectedDate}`,
                date: selectedDate,
                total_energy_kwh: 0,
                electricity_bill: 0
            });
        }

        const totalEnergyKwh = aggregationResult[0].totalPower / 60;
        const electricityBill = Number((totalEnergyKwh * 4.4).toFixed(2));

        res.json({
            date: selectedDate,
            samples: aggregationResult[0].count,
            total_energy_kwh: Number(totalEnergyKwh.toFixed(2)),
            electricity_bill: electricityBill,
        });

    } catch (err) {
        console.error('Error:', err);
        res.status(500).json({ error: 'Failed to process data' });
    }
});

// Daily Bill - ระบุวันที่ผ่าน URL parameter
app.get('/daily-bill/:date', async (req, res) => {
    try {
        const dateStr = req.params.date.trim();

        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
            return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
        }

        const start = new Date(`${dateStr}T00:00:00Z`);
        const end = new Date(`${dateStr}T23:59:59.999Z`);

        const agg = await power_px_dh11.aggregate([
            { $match: { timestamp: { $gte: start, $lte: end } } },
            {
                $group: {
                    _id: null,
                    totalPowerKWsum: { $sum: '$power' },
                    count: { $sum: 1 },
                },
            },
        ]);

        if (!agg.length) {
            return res.status(404).json({ error: `No data found for ${dateStr}` });
        }

        const totalEnergyKwh = agg[0].totalPowerKWsum / 60;
        const electricityBill = Number((totalEnergyKwh * 4.4).toFixed(2));

        res.json({
            date: dateStr,
            samples: agg[0].count,
            total_energy_kwh: Number(totalEnergyKwh.toFixed(2)),
            electricity_bill: electricityBill,
        });
    } catch (err) {
        console.error('Error:', err);
        res.status(500).json({ error: 'Failed to process data' });
    }
});

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'OK', service: 'px_dh Daily Bill API' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});