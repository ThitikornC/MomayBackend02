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

function getDayRangeUTC(dateStr) {
    const start = new Date(`${dateStr}T00:00:00Z`);
    const end = new Date(`${dateStr}T23:59:59Z`);
    return { start, end };
}

// แปลง YYYY-MM เป็น UTC month range
function getMonthRange(yearMonth) {
    const start = new Date(`${yearMonth}-01T00:00:00Z`);
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
        version: '1.0.6',
        timestamp: new Date().toISOString()
    });
});

// ================= Daily Bill =================
app.get('/daily-bill', async (req, res) => {
    try {
        const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
        const selectedDate = req.query.date || today;

        if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) {
            return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD', example: '2025-09-30' });
        }

        const { start, end } = getDayRangeUTC(selectedDate);

        const data = await PowerPXDH11.find({ timestamp: { $gte: start, $lte: end } })
                                      .sort({ timestamp: 1 })
                                      .select('power timestamp');

        if (!data.length) {
            return res.status(404).json({
                error: `No data found for ${selectedDate}`,
                date: selectedDate,
                total_energy_kwh: 0,
                electricity_bill: 0
            });
        }

        let totalEnergyKwh = 0;
        let maxPower = 0;
        let minPower = Infinity;
        let totalPowerSum = 0;

        for (let i = 0; i < data.length; i++) {
            const p = data[i].power;
            totalPowerSum += p;
            if (p > maxPower) maxPower = p;
            if (p < minPower) minPower = p;

            if (i === 0) continue;
            const intervalHours = (data[i].timestamp - data[i-1].timestamp) / 1000 / 3600;
            totalEnergyKwh += ((data[i].power + data[i-1].power) / 2) * intervalHours;
        }

        const avgPower = totalPowerSum / data.length;
        const electricityBill = calculateBill(totalEnergyKwh);

        res.json({
            date: selectedDate,
            samples: data.length,
            total_energy_kwh: Number(totalEnergyKwh.toFixed(2)),
            avg_power_kw: Number(avgPower.toFixed(2)),
            max_power_kw: Number(maxPower.toFixed(2)),
            min_power_kw: Number(minPower.toFixed(2)),
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

// ================= Daily Calendar =================
app.get('/calendar', async (req, res) => {
  try {
    const agg = await PowerPXDH11.aggregate([
      {
        $project: {
          power: 1,
          localDate: {
            $dateToString: { format: "%Y-%m-%d", date: "$timestamp", timezone: "UTC" }
          }
        }
      },
      {
        $group: {
          _id: "$localDate",
          avgPower: { $avg: "$power" },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    if (!agg.length) return res.status(404).json({ error: "No data found" });

    const events = [];

    for (const item of agg) {
      // หา dayData ทั้งวันมา integrate หา kWh
      const dayData = await PowerPXDH11.find({
        timestamp: {
          $gte: new Date(`${item._id}T00:00:00Z`),
          $lt: new Date(`${item._id}T23:59:59Z`)
        }
      }).sort({ timestamp: 1 }).select("power timestamp");

      let totalEnergyKwh = 0;
      for (let i = 1; i < dayData.length; i++) {
        const p1 = dayData[i - 1].power;
        const p2 = dayData[i].power;
        const intervalHrs = (dayData[i].timestamp - dayData[i - 1].timestamp) / 1000 / 3600;
        totalEnergyKwh += ((p1 + p2) / 2) * intervalHrs;
      }

      totalEnergyKwh = Number(totalEnergyKwh.toFixed(2));
      const bill = calculateBill(totalEnergyKwh);

      events.push({
        title: `${totalEnergyKwh} Unit`,
        start: item._id,
        extendedProps: { type: "energy", display_text: `${totalEnergyKwh} Unit` }
      });

      events.push({
        title: `${bill}฿`,
        start: item._id,
        extendedProps: { type: "bill", display_text: `${bill}฿` }
      });
    }

    res.json(events);
  } catch (err) {
    console.error("❌ /calendar error:", err);
    res.status(500).json({ error: "Failed to get calendar data", message: err.message });
  }
});

// ================= Daily Diff =================
app.get('/daily-diff', async (req, res) => {
    try {
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);
        const dayBefore = new Date(today);
        dayBefore.setDate(today.getDate() - 2);

        const formatDate = (date) => date.toLocaleDateString('en-CA');

        const getDailyEnergy = async (dateStr) => {
            const { start, end } = getDayRangeUTC(dateStr);
            const dayData = await PowerPXDH11.find({ timestamp: { $gte: start, $lte: end } })
                                             .sort({ timestamp: 1 })
                                             .select('power timestamp');

            if (!dayData.length) return { energy_kwh: 0, samples: 0, electricity_bill: 0 };

            let totalEnergyKwh = 0;
            let count = 0;
            let totalPower = 0;
            for (let i = 0; i < dayData.length; i++) {
                const p = dayData[i].power;
                totalPower += p;
                count++;
                if (i === 0) continue;
                const intervalHours = (dayData[i].timestamp - dayData[i-1].timestamp) / 1000 / 3600;
                totalEnergyKwh += ((dayData[i].power + dayData[i-1].power) / 2) * intervalHours;
            }

            return { energy_kwh: Number(totalEnergyKwh.toFixed(2)), samples: count, electricity_bill: calculateBill(totalEnergyKwh) };
        };

        const yestData = await getDailyEnergy(formatDate(yesterday));
        const dayBeforeData = await getDailyEnergy(formatDate(dayBefore));

        const diffKwh = Number((yestData.energy_kwh - dayBeforeData.energy_kwh).toFixed(2));
        const diffBill = Number((yestData.electricity_bill - dayBeforeData.electricity_bill).toFixed(2));

        res.json({
            yesterday: { date: formatDate(yesterday), ...yestData },
            dayBefore: { date: formatDate(dayBefore), ...dayBeforeData },
            diff: { kWh: diffKwh, electricity_bill: diffBill }
        });

    } catch (err) {
        console.error('❌ /daily-diff error:', err);
        res.status(500).json({ error: 'Failed to get daily diff', message: err.message });
    }
});

// ================= Hourly Bill =================
app.get('/hourly-bill/:date', async (req, res) => {
    try {
        const selectedDate = req.params.date;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) {
            return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
        }

        const { start, end } = getDayRangeUTC(selectedDate);

        const data = await PowerPXDH11.find({ timestamp: { $gte: start, $lte: end } })
                                      .sort({ timestamp: 1 })
                                      .select('power timestamp');

        if (!data.length) {
            return res.status(404).json({
                error: `No data found for ${selectedDate}`,
                date: selectedDate,
                hourly: []
            });
        }

        const hourlyEnergy = {};

        for (let i = 1; i < data.length; i++) {
            const prev = data[i-1];
            const curr = data[i];

            const intervalHours = (curr.timestamp - prev.timestamp) / 1000 / 3600;
            const avgPower = (curr.power + prev.power) / 2;
            const energyKwh = avgPower * intervalHours;

            const hourKey = prev.timestamp.getHours();
            if (!hourlyEnergy[hourKey]) hourlyEnergy[hourKey] = 0;
            hourlyEnergy[hourKey] += energyKwh;
        }

        const hourlyArray = [];
        for (let h = 0; h < 24; h++) {
            hourlyArray.push({
                hour: `${h.toString().padStart(2, '0')}:00`,
                energy_kwh: Number((hourlyEnergy[h] || 0).toFixed(2)),
                electricity_bill: calculateBill(hourlyEnergy[h] || 0)
            });
        }

        res.json({
            date: selectedDate,
            hourly: hourlyArray
        });

    } catch (err) {
        console.error('❌ /hourly-bill error:', err);
        res.status(500).json({ error: 'Failed to get hourly bill', message: err.message });
    }
});

// ================= Minute Power Range with custom time range =================
app.get('/minute-power-range', async (req, res) => {
    try {
        const { date, startHour, endHour } = req.query; // date = YYYY-MM-DD, startHour, endHour = 0-23

        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({
                error: "Missing or invalid date",
                example: "/minute-power-range?date=2025-10-03&startHour=8&endHour=17"
            });
        }

        // เริ่มต้นวัน UTC
        let { start, end } = getDayRangeUTC(date);

        // ปรับช่วงเวลา ถ้ามี startHour / endHour
        if (startHour !== undefined) start.setUTCHours(Number(startHour), 0, 0, 0);
        if (endHour !== undefined) end.setUTCHours(Number(endHour), 59, 59, 999);

        const data = await PowerPXDH11.find({
            timestamp: { $gte: start, $lte: end }
        }).sort({ timestamp: 1 })
          .select('timestamp power voltage current active_power_phase_a active_power_phase_b active_power_phase_c');

        const result = data.map(d => ({
            timestamp: d.timestamp.toISOString(),
            power: d.power,
            voltage: d.voltage,
            current: d.current,
            active_power_phase_a: d.active_power_phase_a,
            active_power_phase_b: d.active_power_phase_b,
            active_power_phase_c: d.active_power_phase_c
        }));

        res.json(result);

    } catch (err) {
        console.error('❌ /minute-power-range error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ================= Hourly kWh & Bill =================
app.get('/hourly-summary', async (req, res) => {
    try {
        const { date } = req.query; // date = YYYY-MM-DD

        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({
                error: "Missing or invalid date",
                example: "/hourly-summary?date=2025-10-03"
            });
        }

        // ช่วงวัน UTC
        const { start, end } = getDayRangeUTC(date);

        // ดึงข้อมูล
        const data = await PowerPXDH11.find({
            timestamp: { $gte: start, $lte: end }
        }).sort({ timestamp: 1 }).select('timestamp power');

        // เตรียม array 24 ชั่วโมง
        const hourly = Array.from({ length: 24 }, (_, i) => ({
            hour: `${i.toString().padStart(2,'0')}:00`,
            energy_kwh: 0,
            electricity_bill: 0
        }));

        for (let i = 1; i < data.length; i++) {
            const prev = data[i-1];
            const curr = data[i];

            const intervalHours = (curr.timestamp - prev.timestamp) / 1000 / 3600; // ชั่วโมง
            const avgPower = (curr.power + prev.power) / 2;
            const energyKwh = avgPower * intervalHours;

            const hourKey = prev.timestamp.getUTCHours();
            hourly[hourKey].energy_kwh += energyKwh;
        }

        // ปัดค่าและคำนวณค่าไฟ
        hourly.forEach(h => {
            h.energy_kwh = Number(h.energy_kwh.toFixed(2));
            h.electricity_bill = Number((h.energy_kwh * 4.4).toFixed(2)); // rate 4.4
        });

        res.json({
            date,
            hourly
        });

    } catch (err) {
        console.error('❌ /hourly-summary error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ================= Solar Size =================
app.get('/solar-size', async (req, res) => {
    try {
        const { date, ratePerKwh = 4.4 } = req.query;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ 
                error: "Missing or invalid date. Use YYYY-MM-DD",
                example: "/solar-size?date=2025-10-03"
            });
        }

        const { start, end } = getDayRangeUTC(date);
        const data = await PowerPXDH11.find({ timestamp: { $gte: start, $lte: end } })
                                      .sort({ timestamp: 1 })
                                      .select('timestamp power');

        if (!data.length) {
            return res.status(404).json({ 
                error: `No data found for ${date}`,
                date,
                totalEnergyKwh: 0
            });
        }

        // รวม energy รายชั่วโมงแบบ /hourly-bill (local hour)
        const hourlyEnergy = {};
        for (let i = 1; i < data.length; i++) {
            const prev = data[i-1];
            const curr = data[i];
            const intervalHours = (curr.timestamp - prev.timestamp) / 1000 / 3600;
            const avgPower = (curr.power + prev.power) / 2;

            const hourKey = prev.timestamp.getHours(); // local hour
            if (!hourlyEnergy[hourKey]) hourlyEnergy[hourKey] = 0;
            hourlyEnergy[hourKey] += avgPower * intervalHours;
        }

        // รวม energy เฉพาะชั่วโมง 06:00–18:00 (local)
        const totalEnergyKwh = Object.keys(hourlyEnergy)
            .filter(h => Number(h) >= 6 && Number(h) <= 18)
            .reduce((sum, h) => sum + hourlyEnergy[h], 0);

        const H_sun = 4;
        const solarCapacity_kW = totalEnergyKwh / H_sun;
        const savingsDay = totalEnergyKwh * ratePerKwh;
        const savingsMonth = savingsDay * 30;
        const savingsYear = savingsDay * 365;

        res.json({
            date,
            totalEnergyKwh: Number(totalEnergyKwh.toFixed(2)),
            sunHours: H_sun,
            solarCapacity_kW: Number(solarCapacity_kW.toFixed(2)),
            savingsDay: Number(savingsDay.toFixed(2)),
            savingsMonth: Number(savingsMonth.toFixed(2)),
            savingsYear: Number(savingsYear.toFixed(2))
        });

    } catch (err) {
        console.error('❌ /solar-size error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ================= Diagnostics Range Endpoint =================
app.get('/diagnostics-range', async (req, res) => {
  try {
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({
        error: "Missing query params",
        example: "/diagnostics-range?start=2025-10-02T17:00:00Z&end=2025-10-02T17:05:00Z"
      });
    }

    const data = await PowerPXDH11.find({
      timestamp: {
        $gte: new Date(start),
        $lte: new Date(end)
      }
    })
    .sort({ timestamp: 1 })
    .select('timestamp power voltage current active_power_phase_a active_power_phase_b active_power_phase_c');

    // ตัด Z ออก
    const result = data.map(d => ({
      _id: d._id,
      voltage: d.voltage,
      current: d.current,
      power: d.power,
      active_power_phase_a: d.active_power_phase_a,
      active_power_phase_b: d.active_power_phase_b,
      active_power_phase_c: d.active_power_phase_c,
      timestamp: d.timestamp.toISOString().replace('Z','') // ตัด Z
    }));

    res.json(result);

  } catch (err) {
    console.error('❌ /diagnostics-range error:', err);
    res.status(500).json({ error: "Failed", message: err.message });
  }
});

// ================= Graceful Shutdown =================
process.on('SIGTERM', async () => {
    console.log('🔄 SIGTERM received, closing server...');
    await mongoose.connection.close();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('🔄 SIGINT received, closing server...');
    await mongoose.connection.close();
    process.exit(0);
});

// ================= Start Server =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/`);
});
