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

// ================= Notification Schemas (แยก collection) =================

// 1. Peak Notifications
const peakNotificationSchema = new mongoose.Schema({
    title: { type: String, required: true },
    body: { type: String, required: true },
    power: { type: Number, required: true },
    timestamp: { type: Date, default: () => new Date(Date.now() + 7*60*60*1000) },
    read: { type: Boolean, default: false }
}, { timestamps: true });

const PeakNotification = mongoose.model("peak_notifications", peakNotificationSchema);

// 2. Daily Diff Notifications
const dailyDiffNotificationSchema = new mongoose.Schema({
    title: { type: String, required: true },
    body: { type: String, required: true },
    yesterday: {
        date: String,
        energy_kwh: Number,
        electricity_bill: Number,
        samples: Number
    },
    dayBefore: {
        date: String,
        energy_kwh: Number,
        electricity_bill: Number,
        samples: Number
    },
    diff: {
        kWh: Number,
        electricity_bill: Number
    },
    timestamp: { type: Date, default: () => new Date(Date.now() + 7*60*60*1000) },
    read: { type: Boolean, default: false }
}, { timestamps: true });

const DailyDiffNotification = mongoose.model("daily_diff_notifications", dailyDiffNotificationSchema);

// 3. Test Notifications
const testNotificationSchema = new mongoose.Schema({
    title: { type: String, required: true },
    body: { type: String, required: true },
    timestamp: { type: Date, default: () => new Date(Date.now() + 7*60*60*1000) },
    read: { type: Boolean, default: false }
}, { timestamps: true });

const TestNotification = mongoose.model("test_notifications", testNotificationSchema);

// ================= Helper Functions =================
function calculateBill(energyKwh, ratePerKwh = 4.4) {
    return Number((energyKwh * ratePerKwh).toFixed(2));
}

function getDayRangeUTC(dateStr) {
    const start = new Date(`${dateStr}T00:00:00Z`);
    const end = new Date(`${dateStr}T23:59:59Z`);
    return { start, end };
}
function getDayRangeUTCFromThailand(dateStr) {
    const startTH = new Date(`${dateStr}T00:00:00`);
    const endTH = new Date(`${dateStr}T23:59:59`);
    return { start: new Date(startTH.getTime() - 7*3600*1000),
             end: new Date(endTH.getTime() - 7*3600*1000) };
}
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
        version: '1.1.0',
        timestamp: new Date().toISOString()
    });
});

// ================= Daily Bill =================
app.get('/daily-bill', async (req, res) => {
    try {
        const today = new Date().toLocaleDateString('en-CA');
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

        const diffKwh = Number((dayBeforeData.energy_kwh - yestData.energy_kwh ).toFixed(2));
        const diffBill = Number((dayBeforeData.electricity_bill - yestData.electricity_bill).toFixed(2));

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

function addEnergyToHours(prev, curr, hourlyEnergy) {
    let start = new Date(prev.timestamp);
    const end = new Date(curr.timestamp);
    const power = (prev.power + curr.power) / 2;

    while (start < end) {
        const nextHour = new Date(start);
        nextHour.setMinutes(60, 0, 0);
        const intervalEnd = nextHour < end ? nextHour : end;
        const intervalHours = (intervalEnd - start) / 1000 / 3600;

        const hourKey = start.getHours();
        if (!hourlyEnergy[hourKey]) hourlyEnergy[hourKey] = 0;
        hourlyEnergy[hourKey] += power * intervalHours;

        start = intervalEnd;
    }
}

// ================= Hourly Bill =================
app.get('/hourly-bill/:date', async (req, res) => {
    try {
        const selectedDate = req.params.date;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) {
            return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
        }

        const start = new Date(`${selectedDate}T00:00:00`);
        const end = new Date(`${selectedDate}T23:59:59`);

        const data = await PowerPXDH11.find({ timestamp: { $gte: start, $lte: end } })
                                      .sort({ timestamp: 1 })
                                      .select('power timestamp');

        const hourlyEnergy = Array.from({length:24}, ()=>0);

        if (data.length === 0) {
            return res.json({
                date: selectedDate,
                hourly: hourlyEnergy.map((e,h)=>({
                    hour: `${h.toString().padStart(2,'0')}:00`,
                    energy_kwh: 0,
                    electricity_bill: 0
                }))
            });
        }

        function addEnergy(prev, curr) {
            let startTime = new Date(prev.timestamp);
            const endTime = new Date(curr.timestamp);
            const avgPower = (prev.power + curr.power)/2;

            while (startTime < endTime) {
                const nextHour = new Date(startTime);
                nextHour.setMinutes(60,0,0);
                const intervalEnd = nextHour < endTime ? nextHour : endTime;
                const intervalHours = (intervalEnd - startTime)/1000/3600;

                const hour = startTime.getHours();
                hourlyEnergy[hour] += avgPower * intervalHours;

                startTime = intervalEnd;
            }
        }

        for (let i = 1; i < data.length; i++) {
            addEnergy(data[i-1], data[i]);
        }

        const now = new Date();
        if (selectedDate === now.toISOString().slice(0,10)) {
            for (let h = now.getHours()+1; h < 24; h++) {
                hourlyEnergy[h] = 0;
            }
        }

        const hourlyArray = hourlyEnergy.map((energy, h) => ({
            hour: `${h.toString().padStart(2,'0')}:00`,
            energy_kwh: Number(energy.toFixed(2)),
            electricity_bill: Number((energy*4.4).toFixed(2))
        }));

        res.json({
            date: selectedDate,
            hourly: hourlyArray
        });

    } catch (err) {
        console.error('❌ /hourly-bill error:', err);
        res.status(500).json({ error: 'Failed to get hourly bill', message: err.message });
    }
});

// ================= Minute Power Range =================
app.get('/minute-power-range', async (req, res) => {
    try {
        const { date, startHour, endHour } = req.query;

        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({
                error: "Missing or invalid date",
                example: "/minute-power-range?date=2025-10-03&startHour=8&endHour=17"
            });
        }

        let { start, end } = getDayRangeUTC(date);

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

// ================= Hourly Summary =================
app.get('/hourly-summary', async (req, res) => {
    try {
        const { date } = req.query;

        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({
                error: "Missing or invalid date",
                example: "/hourly-summary?date=2025-10-03"
            });
        }

        const { start, end } = getDayRangeUTC(date);

        const data = await PowerPXDH11.find({
            timestamp: { $gte: start, $lte: end }
        }).sort({ timestamp: 1 }).select('timestamp power');

        const hourly = Array.from({ length: 24 }, (_, i) => ({
            hour: `${i.toString().padStart(2,'0')}:00`,
            energy_kwh: 0,
            electricity_bill: 0
        }));

        for (let i = 1; i < data.length; i++) {
            const prev = data[i-1];
            const curr = data[i];

            const intervalHours = (curr.timestamp - prev.timestamp) / 1000 / 3600;
            const avgPower = (curr.power + prev.power) / 2;
            const energyKwh = avgPower * intervalHours;

            const hourKey = prev.timestamp.getUTCHours();
            hourly[hourKey].energy_kwh += energyKwh;
        }

        hourly.forEach(h => {
            h.energy_kwh = Number(h.energy_kwh.toFixed(2));
            h.electricity_bill = Number((h.energy_kwh * 4.4).toFixed(2));
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

// ================= Session =================
const session = require('express-session');
const MongoStore = require('connect-mongo');

app.use(session({
    secret: process.env.SESSION_SECRET || 'keyboard_cat',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
    cookie: { maxAge: 24*60*60*1000 }
}));

// ================= Daily Diff Popup =================
app.get('/daily-diff-popup', async (req, res) => {
    try {
        const todayStr = new Date().toISOString().split('T')[0];

        if (!req.session.lastPopupDate || req.session.lastPopupDate !== todayStr) {
            const axios = require('axios');
            const diffResp = await axios.get(`http://localhost:${PORT}/daily-diff`);

            req.session.lastPopupDate = todayStr;

            return res.json({
                showPopup: true,
                data: diffResp.data
            });
        }

        res.json({ showPopup: false });

    } catch (err) {
        console.error('❌ /daily-diff-popup error:', err.message);
        res.status(500).json({ showPopup: false, error: err.message });
    }
});

// ================= Solar Size =================
app.get('/solar-size', async (req, res) => {
    try {
        const { date, ratePerKwh = 4.4 } = req.query;

        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ 
                error: "Missing or invalid date. Use YYYY-MM-DD",
                example: "/solar-size?date=2025-10-07"
            });
        }

        const start = new Date(`${date}T00:00:00Z`);
        const end = new Date(`${date}T23:59:59Z`);

        const data = await PowerPXDH11.find({
            timestamp: { $gte: start, $lte: end }
        }).sort({ timestamp: 1 }).select('timestamp power');

        if (!data.length) {
            return res.status(404).json({
                error: `No data for ${date}`,
                date,
                hourly: Array.from({length:24}, (_,h) => ({
                    hour: `${h.toString().padStart(2,'0')}:00`,
                    energy_kwh: 0,
                    electricity_bill: 0,
                    peak_power: 0
                })),
                dayEnergy: 0,
                nightEnergy: 0,
                totalEnergyKwh: 0,
                solarCapacity_kW: 0,
                peakPowerDay: 0,
                savingsDay: 0,
                savingsMonth: 0,
                savingsYear: 0
            });
        }

        const hourlyEnergy = Array.from({length:24}, () => 0);
        const hourlyPeak = Array.from({length:24}, () => 0);

        for (let i = 1; i < data.length; i++) {
            const prev = data[i-1];
            const curr = data[i];
            let t = new Date(prev.timestamp);
            const endTime = new Date(curr.timestamp);
            const avgPower = (prev.power + curr.power) / 2;

            while (t < endTime) {
                const hourIndex = t.getUTCHours();
                const nextHour = new Date(t);
                nextHour.setUTCHours(nextHour.getUTCHours()+1,0,0,0);
                const intervalEnd = nextHour < endTime ? nextHour : endTime;
                const intervalHours = (intervalEnd - t) / 1000 / 3600;

                hourlyEnergy[hourIndex] += avgPower * intervalHours;
                hourlyPeak[hourIndex] = Math.max(hourlyPeak[hourIndex], prev.power, curr.power);

                t = intervalEnd;
            }
        }

        const hourlyArray = hourlyEnergy.map((energy,h) => ({
            hour: `${h.toString().padStart(2,'0')}:00`,
            energy_kwh: Number(energy.toFixed(2)),
            electricity_bill: Number((energy*ratePerKwh).toFixed(2)),
            peak_power: Number(hourlyPeak[h].toFixed(2))
        }));

        const dayEnergy = hourlyArray
            .slice(6, 19)
            .reduce((sum,o) => sum + o.energy_kwh, 0);

        const nightEnergy = hourlyArray
            .filter((_,h) => h < 6 || h > 18)
            .reduce((sum,o) => sum + o.energy_kwh, 0);

        const totalEnergyKwh = dayEnergy + nightEnergy;
        const peakPowerDay = Math.max(...hourlyPeak);

        const H_sun = 4;
        const solarCapacity_kW = dayEnergy / H_sun;
        const savingsDay = dayEnergy * ratePerKwh;

        res.json({
            date,
            hourly: hourlyArray,
            dayEnergy: Number(dayEnergy.toFixed(2)),
            nightEnergy: Number(nightEnergy.toFixed(2)),
            dayCost: Number((dayEnergy * ratePerKwh).toFixed(2)),
            nightCost: Number((nightEnergy * ratePerKwh).toFixed(2)),
            totalEnergyKwh: Number(totalEnergyKwh.toFixed(2)),
            totalCost: Number((totalEnergyKwh * ratePerKwh).toFixed(2)),
            sunHours: H_sun,
            solarCapacity_kW: Number(solarCapacity_kW.toFixed(2)),
            peakPowerDay: Number(peakPowerDay.toFixed(2)),
            savingsDay: Number(savingsDay.toFixed(2)),
            savingsMonth: Number((savingsDay*30).toFixed(2)),
            savingsYear: Number((savingsDay*365).toFixed(2))
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ================= Raw Local =================
app.get('/raw-local', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'Missing date' });

    const start = new Date(`${date}T08:00:00+07:00`);
    const end   = new Date(`${date}T09:00:00+07:00`);

    const data = await PowerPXDH11.find({
      timestamp: { $gte: start, $lte: end }
    }).sort({ timestamp: 1 });

    const totalPower = data.reduce((sum, d) => sum + d.power, 0);

    res.json({
      date,
      period: "08:00-09:00",
      count: data.length,
      totalPower: Number(totalPower.toFixed(3)),
      data
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/raw-08-09', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "Invalid date. Use YYYY-MM-DD" });
    }

    const start = new Date(`${date}T08:00:00.000Z`);
    const end = new Date(`${date}T08:59:59.999Z`);

    const data = await PowerPXDH11.find({
      timestamp: { $gte: start, $lte: end }
    }).sort({ timestamp: 1 });

    const totalPower = data.reduce((sum, d) => sum + d.power, 0);

    res.json({
      date,
      period: "08:00-09:00 UTC",
      count: data.length,
      totalPower: Number(totalPower.toFixed(3)),
      data
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ================= Diagnostics Range =================
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

    const result = data.map(d => ({
      _id: d._id,
      voltage: d.voltage,
      current: d.current,
      power: d.power,
      active_power_phase_a: d.active_power_phase_a,
      active_power_phase_b: d.active_power_phase_b,
      active_power_phase_c: d.active_power_phase_c,
      timestamp: d.timestamp.toISOString().replace('Z','')
    }));

    res.json(result);

  } catch (err) {
    console.error('❌ /diagnostics-range error:', err);
    res.status(500).json({ error: "Failed", message: err.message });
  }
});

// ================== PUSH NOTIFICATION SYSTEM ==================
const webpush = require('web-push');
const cron = require('node-cron');

webpush.setVapidDetails(
  'mailto:admin@yourdomain.com',
  'BB2fZ3NOzkWDKOi8H5jhbwICDTv760wIB6ZD2PwmXcUA_B5QXkXtely4b4JZ5v5b88VX1jKa7kRfr94nxqiksqY',
  'jURJII6DrBN9N_8WtNayWs4bXWDNzeb_RyjXnTxaDmo'
);

let pushSubscriptions = [];

// สมัครรับการแจ้งเตือน
app.post('/api/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }

  const exists = pushSubscriptions.find(s => s.endpoint === sub.endpoint);
  if (!exists) pushSubscriptions.push(sub);

  console.log(`✅ Push subscription added (${pushSubscriptions.length} total)`);
  res.status(201).json({ message: 'Subscribed successfully' });
});

// ฟังก์ชันส่ง Push Notification พร้อมบันทึกลง DB แยก collection
async function sendPushNotification(title, body, type = 'test', data = {}) {
  try {
    let notification;

    // 1. บันทึกลง Database แยกตาม type
    switch(type) {
      case 'peak':
        notification = await PeakNotification.create({
          title,
          body,
          power: data.power
        });
        console.log('💾 Peak Notification saved:', notification._id);
        break;

      case 'daily_diff':
        notification = await DailyDiffNotification.create({
          title,
          body,
          yesterday: data.yesterday,
          dayBefore: data.dayBefore,
          diff: data.diff
        });
        console.log('💾 Daily Diff Notification saved:', notification._id);
        break;

      case 'test':
        notification = await TestNotification.create({
          title,
          body
        });
        console.log('💾 Test Notification saved:', notification._id);
        break;

      default:
        console.error('❌ Unknown notification type:', type);
        return null;
    }

    // 2. ส่ง Push notification
    const payload = JSON.stringify({ title, body, url: '/' });

    if (!pushSubscriptions.length) {
      console.log('⚠️ No push subscriptions to send to');
      return notification;
    }

    for (let i = pushSubscriptions.length - 1; i >= 0; i--) {
      const sub = pushSubscriptions[i];
      try {
        await webpush.sendNotification(sub, payload);
        console.log('📤 Sent notification to', sub.endpoint);
      } catch (err) {
        console.error('❌ Push send error for', sub.endpoint, err.statusCode || err);
        const status = err && err.statusCode;
        if (status === 410 || status === 404) {
          pushSubscriptions.splice(i, 1);
          console.log('🗑 Removed expired subscription', sub.endpoint);
        }
      }
    }

    return notification;
  } catch (err) {
    console.error('❌ Error in sendPushNotification:', err);
    throw err;
  }
}

// ================== REALTIME PEAK CHECK ==================
let dailyPeak = { date: '', maxPower: 0 };

async function checkDailyPeak() {
  try {
    const latest = await PowerPXDH11.findOne().sort({ timestamp: -1 }).select('power timestamp');
    if (!latest) return;

    const today = new Date().toISOString().split('T')[0];

    if (dailyPeak.date !== today) {
      dailyPeak = { date: today, maxPower: 0 };
      console.log(`🔁 Reset daily peak for ${today}`);
    }

    const powerNow = latest.power || 0;
    if (powerNow > dailyPeak.maxPower) {
      dailyPeak.maxPower = powerNow;
      console.log(`🚨 New peak ${powerNow.toFixed(2)} kW at ${latest.timestamp}`);

      await sendPushNotification(
        '⚡ New Daily Peak!',
        `Current peak power is ${powerNow.toFixed(2)} kW`,
        'peak',
        { power: powerNow }
      );
    }
  } catch (err) {
    console.error('❌ Error checking daily peak:', err);
  }
}

// ตรวจสอบ peak ทุก 10 วินาที
cron.schedule('*/10 * * * * *', () => {
  checkDailyPeak();
});

// ================== TEST PUSH ==================
app.get('/api/test-push', async (req, res) => {
  try {
    await sendPushNotification(
      '🔔 Test Push',
      'การแจ้งเตือนทดสอบทำงานแล้ว!',
      'test',
      {}
    );
    res.send('✅ Push sent and saved to DB');
  } catch (err) {
    console.error('❌ test-push error:', err);
    res.status(500).send('❌ Failed to send test push');
  }
});

// ================== NOTIFICATION API ==================

// 1. ดึง Peak Notifications
app.get('/api/notifications/peak', async (req, res) => {
  try {
    const { limit = 50, page = 1, unreadOnly = false } = req.query;
    const query = unreadOnly === 'true' ? { read: false } : {};
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const notifications = await PeakNotification.find(query)
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .skip(skip);

    const total = await PeakNotification.countDocuments(query);
    const unreadCount = await PeakNotification.countDocuments({ read: false });

    res.json({
      success: true,
      type: 'peak',
      data: notifications,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      },
      unreadCount
    });
  } catch (err) {
    console.error('❌ GET /api/notifications/peak error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. ดึง Daily Diff Notifications
app.get('/api/notifications/daily-diff', async (req, res) => {
  try {
    const { limit = 50, page = 1, unreadOnly = false } = req.query;
    const query = unreadOnly === 'true' ? { read: false } : {};
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const notifications = await DailyDiffNotification.find(query)
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .skip(skip);

    const total = await DailyDiffNotification.countDocuments(query);
    const unreadCount = await DailyDiffNotification.countDocuments({ read: false });

    res.json({
      success: true,
      type: 'daily_diff',
      data: notifications,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      },
      unreadCount
    });
  } catch (err) {
    console.error('❌ GET /api/notifications/daily-diff error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. ดึง Test Notifications
app.get('/api/notifications/test', async (req, res) => {
  try {
    const { limit = 50, page = 1, unreadOnly = false } = req.query;
    const query = unreadOnly === 'true' ? { read: false } : {};
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const notifications = await TestNotification.find(query)
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .skip(skip);

    const total = await TestNotification.countDocuments(query);
    const unreadCount = await TestNotification.countDocuments({ read: false });

    res.json({
      success: true,
      type: 'test',
      data: notifications,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      },
      unreadCount
    });
  } catch (err) {
    console.error('❌ GET /api/notifications/test error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. ดึงทั้งหมด (รวม 3 collections)
app.get('/api/notifications/all', async (req, res) => {
  try {
    const { limit = 50, page = 1, unreadOnly = false } = req.query;
    const query = unreadOnly === 'true' ? { read: false } : {};
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const peakNoti = await PeakNotification.find(query)
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .skip(skip)
      .lean();
    
    const dailyDiffNoti = await DailyDiffNotification.find(query)
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .skip(skip)
      .lean();
    
    const testNoti = await TestNotification.find(query)
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .skip(skip)
      .lean();

    const allNotifications = [
      ...peakNoti.map(n => ({...n, type: 'peak'})),
      ...dailyDiffNoti.map(n => ({...n, type: 'daily_diff'})),
      ...testNoti.map(n => ({...n, type: 'test'}))
    ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
     .slice(0, parseInt(limit));

    const totalPeak = await PeakNotification.countDocuments(query);
    const totalDaily = await DailyDiffNotification.countDocuments(query);
    const totalTest = await TestNotification.countDocuments(query);
    const total = totalPeak + totalDaily + totalTest;

    const unreadPeak = await PeakNotification.countDocuments({ read: false });
    const unreadDaily = await DailyDiffNotification.countDocuments({ read: false });
    const unreadTest = await TestNotification.countDocuments({ read: false });
    const unreadCount = unreadPeak + unreadDaily + unreadTest;

    res.json({
      success: true,
      data: allNotifications,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      },
      unreadCount,
      breakdown: {
        peak: { total: totalPeak, unread: unreadPeak },
        daily_diff: { total: totalDaily, unread: unreadDaily },
        test: { total: totalTest, unread: unreadTest }
      }
    });
  } catch (err) {
    console.error('❌ GET /api/notifications/all error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. ดึงล่าสุด (รวมทุก type)
app.get('/api/notifications/recent', async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    
    const peakNoti = await PeakNotification.find()
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .lean();
    
    const dailyDiffNoti = await DailyDiffNotification.find()
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .lean();
    
    const testNoti = await TestNotification.find()
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .lean();

    const allNotifications = [
      ...peakNoti.map(n => ({...n, type: 'peak'})),
      ...dailyDiffNoti.map(n => ({...n, type: 'daily_diff'})),
      ...testNoti.map(n => ({...n, type: 'test'}))
    ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
     .slice(0, parseInt(limit));

    const unreadPeak = await PeakNotification.countDocuments({ read: false });
    const unreadDaily = await DailyDiffNotification.countDocuments({ read: false });
    const unreadTest = await TestNotification.countDocuments({ read: false });
    const unreadCount = unreadPeak + unreadDaily + unreadTest;

    res.json({
      success: true,
      data: allNotifications,
      unreadCount,
      breakdown: {
        peak: unreadPeak,
        daily_diff: unreadDaily,
        test: unreadTest
      }
    });
  } catch (err) {
    console.error('❌ GET /api/notifications/recent error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. ทำเครื่องหมายว่าอ่านแล้ว
app.patch('/api/notifications/mark-read', async (req, res) => {
  try {
    const { type, ids } = req.body;

    if (!type || !ids || !Array.isArray(ids)) {
      return res.status(400).json({ 
        success: false, 
        error: 'type and ids array are required',
        example: { type: 'peak', ids: ['id1', 'id2'] }
      });
    }

    let result;
    switch(type) {
      case 'peak':
        result = await PeakNotification.updateMany(
          { _id: { $in: ids } },
          { $set: { read: true } }
        );
        break;
      case 'daily_diff':
        result = await DailyDiffNotification.updateMany(
          { _id: { $in: ids } },
          { $set: { read: true } }
        );
        break;
      case 'test':
        result = await TestNotification.updateMany(
          { _id: { $in: ids } },
          { $set: { read: true } }
        );
        break;
      default:
        return res.status(400).json({ success: false, error: 'Invalid type' });
    }

    res.json({
      success: true,
      message: `Marked ${result.modifiedCount} ${type} notifications as read`,
      modifiedCount: result.modifiedCount
    });
  } catch (err) {
    console.error('❌ PATCH /api/notifications/mark-read error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. ทำเครื่องหมายทั้งหมดว่าอ่านแล้ว
app.patch('/api/notifications/mark-all-read', async (req, res) => {
  try {
    const resultPeak = await PeakNotification.updateMany(
      { read: false },
      { $set: { read: true } }
    );
    
    const resultDaily = await DailyDiffNotification.updateMany(
      { read: false },
      { $set: { read: true } }
    );
    
    const resultTest = await TestNotification.updateMany(
      { read: false },
      { $set: { read: true } }
    );

    const totalModified = resultPeak.modifiedCount + resultDaily.modifiedCount + resultTest.modifiedCount;

    res.json({
      success: true,
      message: `Marked ${totalModified} notifications as read`,
      breakdown: {
        peak: resultPeak.modifiedCount,
        daily_diff: resultDaily.modifiedCount,
        test: resultTest.modifiedCount
      },
      totalModified
    });
  } catch (err) {
    console.error('❌ PATCH /api/notifications/mark-all-read error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. ลบ notification
app.delete('/api/notifications/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;

    let result;
    switch(type) {
      case 'peak':
        result = await PeakNotification.findByIdAndDelete(id);
        break;
      case 'daily_diff':
        result = await DailyDiffNotification.findByIdAndDelete(id);
        break;
      case 'test':
        result = await TestNotification.findByIdAndDelete(id);
        break;
      default:
        return res.status(400).json({ success: false, error: 'Invalid type' });
    }

    if (!result) {
      return res.status(404).json({ success: false, error: 'Notification not found' });
    }

    res.json({
      success: true,
      message: `${type} notification deleted successfully`
    });
  } catch (err) {
    console.error('❌ DELETE /api/notifications error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 9. ลบทั้งหมด (ตาม type หรือทุก type)
app.delete('/api/notifications', async (req, res) => {
  try {
    const { type } = req.query;

    let resultPeak, resultDaily, resultTest;

    if (!type || type === 'all') {
      resultPeak = await PeakNotification.deleteMany({});
      resultDaily = await DailyDiffNotification.deleteMany({});
      resultTest = await TestNotification.deleteMany({});
    } else {
      switch(type) {
        case 'peak':
          resultPeak = await PeakNotification.deleteMany({});
          break;
        case 'daily_diff':
          resultDaily = await DailyDiffNotification.deleteMany({});
          break;
        case 'test':
          resultTest = await TestNotification.deleteMany({});
          break;
        default:
          return res.status(400).json({ success: false, error: 'Invalid type' });
      }
    }

    const totalDeleted = (resultPeak?.deletedCount || 0) + 
                        (resultDaily?.deletedCount || 0) + 
                        (resultTest?.deletedCount || 0);

    res.json({
      success: true,
      message: `Deleted ${totalDeleted} notifications`,
      breakdown: {
        peak: resultPeak?.deletedCount || 0,
        daily_diff: resultDaily?.deletedCount || 0,
        test: resultTest?.deletedCount || 0
      },
      totalDeleted
    });
  } catch (err) {
    console.error('❌ DELETE /api/notifications error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 10. สถิติ notification (แยกตาม type)
app.get('/api/notifications/stats', async (req, res) => {
  try {
    const totalPeak = await PeakNotification.countDocuments();
    const unreadPeak = await PeakNotification.countDocuments({ read: false });
    const latestPeak = await PeakNotification.findOne().sort({ timestamp: -1 });

    const totalDaily = await DailyDiffNotification.countDocuments();
    const unreadDaily = await DailyDiffNotification.countDocuments({ read: false });
    const latestDaily = await DailyDiffNotification.findOne().sort({ timestamp: -1 });

    const totalTest = await TestNotification.countDocuments();
    const unreadTest = await TestNotification.countDocuments({ read: false });
    const latestTest = await TestNotification.findOne().sort({ timestamp: -1 });

    const total = totalPeak + totalDaily + totalTest;
    const unread = unreadPeak + unreadDaily + unreadTest;

    res.json({
      success: true,
      stats: {
        total,
        unread,
        read: total - unread,
        byType: {
          peak: {
            total: totalPeak,
            unread: unreadPeak,
            read: totalPeak - unreadPeak,
            latest: latestPeak
          },
          daily_diff: {
            total: totalDaily,
            unread: unreadDaily,
            read: totalDaily - unreadDaily,
            latest: latestDaily
          },
          test: {
            total: totalTest,
            unread: unreadTest,
            read: totalTest - unreadTest,
            latest: latestTest
          }
        }
      }
    });
  } catch (err) {
    console.error('❌ GET /api/notifications/stats error:', err);
    res.status(500).json({ success: false, error: err.message });
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