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
function getDayRangeUTCFromThailand(dateStr) {
    // เวลาไทย
    const startTH = new Date(`${dateStr}T00:00:00`);
    const endTH = new Date(`${dateStr}T23:59:59`);
    // แปลงเป็น UTC
    return { start: new Date(startTH.getTime() - 7*3600*1000),
             end: new Date(endTH.getTime() - 7*3600*1000) };
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

// ฟังก์ชันช่วยกระจาย energy ตามชั่วโมง
function addEnergyToHours(prev, curr, hourlyEnergy) {
    let start = new Date(prev.timestamp);
    const end = new Date(curr.timestamp);
    const power = (prev.power + curr.power) / 2;

    while (start < end) {
        const nextHour = new Date(start);
        nextHour.setMinutes(60, 0, 0); // ชั่วโมงถัดไป
        const intervalEnd = nextHour < end ? nextHour : end;
        const intervalHours = (intervalEnd - start) / 1000 / 3600;

        const hourKey = start.getHours(); // ใช้เวลาไทยตรง ๆ
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

        // query ตามวัน (เวลาไทยตรง ๆ)
        const start = new Date(`${selectedDate}T00:00:00`);
        const end = new Date(`${selectedDate}T23:59:59`);

        const data = await PowerPXDH11.find({ timestamp: { $gte: start, $lte: end } })
                                      .sort({ timestamp: 1 })
                                      .select('power timestamp');

        // เตรียม array ของ 24 ชั่วโมง
        const hourlyEnergy = Array.from({length:24}, ()=>0);

        if (data.length === 0) {
            // ถ้าไม่มีข้อมูล ให้คืนค่า 0 ทั้งหมด
            return res.json({
                date: selectedDate,
                hourly: hourlyEnergy.map((e,h)=>({
                    hour: `${h.toString().padStart(2,'0')}:00`,
                    energy_kwh: 0,
                    electricity_bill: 0
                }))
            });
        }

        // ฟังก์ชันกระจาย energy ตามชั่วโมงจริง
        function addEnergy(prev, curr) {
            let startTime = new Date(prev.timestamp);
            const endTime = new Date(curr.timestamp);
            const avgPower = (prev.power + curr.power)/2; // kW

            while (startTime < endTime) {
                const nextHour = new Date(startTime);
                nextHour.setMinutes(60,0,0); // จุดสิ้นสุดของชั่วโมงปัจจุบัน
                const intervalEnd = nextHour < endTime ? nextHour : endTime;
                const intervalHours = (intervalEnd - startTime)/1000/3600;

                const hour = startTime.getHours(); // ใช้ getHours() เพราะ DB เป็นเวลาไทย
                hourlyEnergy[hour] += avgPower * intervalHours;

                startTime = intervalEnd;
            }
        }

        for (let i = 1; i < data.length; i++) {
            addEnergy(data[i-1], data[i]);
        }

        // ถ้าเป็นวันนี้ ให้ตัดชั่วโมงที่ยังไม่ถึง
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
// ================= Session =================
const session = require('express-session');
const MongoStore = require('connect-mongo');

app.use(session({
    secret: process.env.SESSION_SECRET || 'keyboard_cat',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
    cookie: { maxAge: 24*60*60*1000 } // 1 วัน
}));

// ================= Daily Diff Popup =================
app.get('/daily-diff-popup', async (req, res) => {
    try {
        const todayStr = new Date().toISOString().split('T')[0];

        // ถ้ายังไม่เคยโชว์วันนี้
        if (!req.session.lastPopupDate || req.session.lastPopupDate !== todayStr) {
            // เรียก daily-diff เดิม
            const axios = require('axios');
            const diffResp = await axios.get(`http://localhost:${PORT}/daily-diff`);

            // บันทึกวันที่ล่าสุดใน session
            req.session.lastPopupDate = todayStr;

            return res.json({
                showPopup: true,
                data: diffResp.data
            });
        }

        // เคยโชว์แล้ววันนี้
        res.json({ showPopup: false });

    } catch (err) {
        console.error('❌ /daily-diff-popup error:', err.message);
        res.status(500).json({ showPopup: false, error: err.message });
    }
});


// ================= Solar Size (UTC, no conversion, 06:00–18:00) =================
app.get('/solar-size', async (req, res) => {
    try {
        const { date, ratePerKwh = 4.4 } = req.query;

        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ 
                error: "Missing or invalid date. Use YYYY-MM-DD",
                example: "/solar-size-utc?date=2025-10-07"
            });
        }

        const start = new Date(`${date}T00:00:00Z`);
        const end = new Date(`${date}T23:59:59Z`);

        // ดึงข้อมูลทั้งวัน
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
                    electricity_bill: 0
                })),
                totalEnergyKwh: 0
            });
        }

        const hourlyEnergy = Array.from({length:24}, () => 0);

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
                t = intervalEnd;
            }
        }

        const hourlyArray = hourlyEnergy.map((energy,h) => ({
            hour: `${h.toString().padStart(2,'0')}:00`,
            energy_kwh: Number(energy.toFixed(2)),
            electricity_bill: Number((energy*ratePerKwh).toFixed(2))
        }));

        // รวมพลังงานเฉพาะ 06:00–18:00
        const totalEnergyKwh = hourlyArray
            .slice(6, 19) // index 6–18 รวม 06:00–18:00
            .reduce((sum,o) => sum + o.energy_kwh, 0);

        const H_sun = 4; // ใช้ค่าคงที่
        const solarCapacity_kW = totalEnergyKwh / H_sun;
        const savingsDay = totalEnergyKwh * ratePerKwh;

        res.json({
            date,
            hourly: hourlyArray,
            totalEnergyKwh: Number(totalEnergyKwh.toFixed(2)),
            sunHours: H_sun,
            solarCapacity_kW: Number(solarCapacity_kW.toFixed(2)),
            savingsDay: Number(savingsDay.toFixed(2)),
            savingsMonth: Number((savingsDay*30).toFixed(2)),
            savingsYear: Number((savingsDay*365).toFixed(2))
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ================= Route raw-local =================
app.get('/raw-local', async (req, res) => {
  try {
    const { date } = req.query; // เช่น "2025-10-07"
    if (!date) return res.status(400).json({ error: 'Missing date' });

    // เวลา 08:00-09:00 local/DB (UTC+7)
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

    // เวลา UTC 08:00-09:00 ตาม DB
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
      data // timestamp จะตรงกับ DB จริง ๆ เลย
    });
  } catch (err) {
    console.error(err);
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
// ================= เพิ่ม Schema สำหรับ Push Notification =================
const notificationSchema = new mongoose.Schema({
    title: { type: String, required: true },
    body: { type: String, required: true },
    type: { 
        type: String, 
        enum: ['peak', 'threshold', 'daily_summary', 'alert', 'info'],
        default: 'info'
    },
    data: { type: Object, default: {} }, // ข้อมูลเพิ่มเติม เช่น power, percentage
    isRead: { type: Boolean, default: false },
    createdAt: { type: Date, default: () => new Date(Date.now() + 7*60*60*1000) }
}, { timestamps: true });

const Notification = mongoose.model("notifications", notificationSchema);

// ================= Schema สำหรับ Push Subscription =================
const subscriptionSchema = new mongoose.Schema({
    endpoint: { type: String, required: true, unique: true },
    keys: {
        p256dh: String,
        auth: String
    },
    userId: String, // เพิ่มในอนาคตถ้ามี user system
    deviceInfo: String,
    isActive: { type: Boolean, default: true },
    lastNotificationAt: Date,
    createdAt: { type: Date, default: () => new Date(Date.now() + 7*60*60*1000) }
}, { timestamps: true });

const PushSubscription = mongoose.model("push_subscriptions", subscriptionSchema);

// ================= API: สมัครรับการแจ้งเตือน (ปรับปรุงให้เก็บใน DB) =================
app.post('/api/subscribe', async (req, res) => {
    try {
        const sub = req.body;
        
        if (!sub || !sub.endpoint) {
            return res.status(400).json({ error: 'Invalid subscription' });
        }

        // ตรวจสอบว่ามีอยู่แล้วหรือไม่
        const existing = await PushSubscription.findOne({ endpoint: sub.endpoint });
        
        if (existing) {
            // อัปเดตข้อมูล
            existing.keys = sub.keys;
            existing.isActive = true;
            existing.deviceInfo = req.headers['user-agent'] || '';
            await existing.save();
            
            return res.json({ message: 'Subscription updated', subscriptionId: existing._id });
        }

        // สร้างใหม่
        const newSub = new PushSubscription({
            endpoint: sub.endpoint,
            keys: sub.keys,
            deviceInfo: req.headers['user-agent'] || ''
        });

        await newSub.save();
        
        console.log(`✅ New push subscription saved: ${newSub._id}`);
        res.status(201).json({ 
            message: 'Subscribed successfully', 
            subscriptionId: newSub._id 
        });

    } catch (err) {
        console.error('❌ Subscribe error:', err);
        res.status(500).json({ error: 'Failed to subscribe', message: err.message });
    }
});

// ================= API: ยกเลิกการแจ้งเตือน =================
app.post('/api/unsubscribe', async (req, res) => {
    try {
        const { endpoint } = req.body;
        
        if (!endpoint) {
            return res.status(400).json({ error: 'Missing endpoint' });
        }

        const sub = await PushSubscription.findOne({ endpoint });
        
        if (!sub) {
            return res.status(404).json({ error: 'Subscription not found' });
        }

        sub.isActive = false;
        await sub.save();

        res.json({ message: 'Unsubscribed successfully' });

    } catch (err) {
        console.error('❌ Unsubscribe error:', err);
        res.status(500).json({ error: 'Failed to unsubscribe', message: err.message });
    }
});

// ================= ฟังก์ชันส่ง Push Notification (ปรับปรุงให้เก็บ DB) =================
async function sendPushNotification(title, body, type = 'info', data = {}) {
    try {
        // 1. บันทึกการแจ้งเตือนลง DB
        const notification = new Notification({
            title,
            body,
            type,
            data
        });
        await notification.save();
        console.log(`💾 Notification saved to DB: ${notification._id}`);

        // 2. ดึง active subscriptions จาก DB
        const subscriptions = await PushSubscription.find({ isActive: true });

        if (!subscriptions.length) {
            console.log('⚠️ No active push subscriptions');
            return;
        }

        const payload = JSON.stringify({ 
            title, 
            body, 
            url: '/',
            notificationId: notification._id.toString(),
            type,
            data
        });

        // 3. ส่งแจ้งเตือนไปยังทุก subscription
        const results = await Promise.allSettled(
            subscriptions.map(async (sub) => {
                try {
                    await webpush.sendNotification({
                        endpoint: sub.endpoint,
                        keys: sub.keys
                    }, payload);
                    
                    // อัปเดตเวลาส่งล่าสุด
                    sub.lastNotificationAt = new Date();
                    await sub.save();
                    
                    console.log(`📤 Sent to ${sub.endpoint.substring(0, 50)}...`);
                    return { success: true, endpoint: sub.endpoint };
                    
                } catch (err) {
                    console.error(`❌ Send failed: ${err.statusCode || err.message}`);
                    
                    // ถ้า subscription หมดอายุ ให้ปิดการใช้งาน
                    if (err.statusCode === 410 || err.statusCode === 404) {
                        sub.isActive = false;
                        await sub.save();
                        console.log(`🗑 Deactivated expired subscription`);
                    }
                    
                    throw err;
                }
            })
        );

        const successCount = results.filter(r => r.status === 'fulfilled').length;
        console.log(`✅ Sent ${successCount}/${subscriptions.length} notifications`);

    } catch (err) {
        console.error('❌ sendPushNotification error:', err);
    }
}

// ================= API: ดึงรายการแจ้งเตือนทั้งหมด =================
app.get('/api/notifications', async (req, res) => {
    try {
        const { limit = 50, skip = 0, type, isRead } = req.query;

        const filter = {};
        if (type) filter.type = type;
        if (isRead !== undefined) filter.isRead = isRead === 'true';

        const notifications = await Notification.find(filter)
            .sort({ createdAt: -1 })
            .limit(parseInt(limit))
            .skip(parseInt(skip));

        const total = await Notification.countDocuments(filter);
        const unreadCount = await Notification.countDocuments({ isRead: false });

        res.json({
            notifications,
            total,
            unreadCount,
            limit: parseInt(limit),
            skip: parseInt(skip)
        });

    } catch (err) {
        console.error('❌ Get notifications error:', err);
        res.status(500).json({ error: 'Failed to get notifications', message: err.message });
    }
});

// ================= API: ดึงการแจ้งเตือนตาม ID =================
app.get('/api/notifications/:id', async (req, res) => {
    try {
        const notification = await Notification.findById(req.params.id);
        
        if (!notification) {
            return res.status(404).json({ error: 'Notification not found' });
        }

        res.json(notification);

    } catch (err) {
        console.error('❌ Get notification error:', err);
        res.status(500).json({ error: 'Failed to get notification', message: err.message });
    }
});

// ================= API: ทำเครื่องหมายว่าอ่านแล้ว =================
app.patch('/api/notifications/:id/read', async (req, res) => {
    try {
        const notification = await Notification.findByIdAndUpdate(
            req.params.id,
            { isRead: true },
            { new: true }
        );

        if (!notification) {
            return res.status(404).json({ error: 'Notification not found' });
        }

        res.json({ message: 'Marked as read', notification });

    } catch (err) {
        console.error('❌ Mark read error:', err);
        res.status(500).json({ error: 'Failed to mark as read', message: err.message });
    }
});

// ================= API: ทำเครื่องหมายอ่านแล้วทั้งหมด =================
app.patch('/api/notifications/read-all', async (req, res) => {
    try {
        const result = await Notification.updateMany(
            { isRead: false },
            { isRead: true }
        );

        res.json({ 
            message: 'All notifications marked as read',
            modifiedCount: result.modifiedCount 
        });

    } catch (err) {
        console.error('❌ Mark all read error:', err);
        res.status(500).json({ error: 'Failed to mark all as read', message: err.message });
    }
});

// ================= API: ลบการแจ้งเตือน =================
app.delete('/api/notifications/:id', async (req, res) => {
    try {
        const notification = await Notification.findByIdAndDelete(req.params.id);

        if (!notification) {
            return res.status(404).json({ error: 'Notification not found' });
        }

        res.json({ message: 'Notification deleted successfully' });

    } catch (err) {
        console.error('❌ Delete notification error:', err);
        res.status(500).json({ error: 'Failed to delete notification', message: err.message });
    }
});

// ================= API: ลบการแจ้งเตือนที่อ่านแล้ว =================
app.delete('/api/notifications/clear-read', async (req, res) => {
    try {
        const result = await Notification.deleteMany({ isRead: true });

        res.json({ 
            message: 'Read notifications cleared',
            deletedCount: result.deletedCount 
        });

    } catch (err) {
        console.error('❌ Clear read error:', err);
        res.status(500).json({ error: 'Failed to clear read notifications', message: err.message });
    }
});

// ================= API: สรุปสถิติการแจ้งเตือน =================
app.get('/api/notifications/stats/summary', async (req, res) => {
    try {
        const total = await Notification.countDocuments();
        const unread = await Notification.countDocuments({ isRead: false });
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayCount = await Notification.countDocuments({ 
            createdAt: { $gte: today } 
        });

        const byType = await Notification.aggregate([
            { $group: { _id: '$type', count: { $sum: 1 } } },
            { $sort: { count: -1 } }
        ]);

        const recentPeak = await Notification.findOne({ type: 'peak' })
            .sort({ createdAt: -1 })
            .select('title body data createdAt');

        res.json({
            total,
            unread,
            todayCount,
            byType,
            recentPeak,
            activeSubscriptions: await PushSubscription.countDocuments({ isActive: true })
        });

    } catch (err) {
        console.error('❌ Stats error:', err);
        res.status(500).json({ error: 'Failed to get stats', message: err.message });
    }
});

// ================= API: ส่งการแจ้งเตือนทดสอบ =================
app.post('/api/notifications/test', async (req, res) => {
    try {
        const { title = '🔔 Test Notification', body = 'This is a test notification from the system' } = req.body;

        await sendPushNotification(title, body, 'info', { test: true });

        res.json({ message: 'Test notification sent successfully' });

    } catch (err) {
        console.error('❌ Test notification error:', err);
        res.status(500).json({ error: 'Failed to send test notification', message: err.message });
    }
});

// ================= ปรับปรุงฟังก์ชัน checkDailyPeak ให้ใช้ระบบใหม่ =================
async function checkDailyPeak() {
    try {
        const latest = await PowerPXDH11.findOne().sort({ timestamp: -1 }).select('power timestamp');
        if (!latest) return;

        const today = new Date().toISOString().split('T')[0];
        const powerNow = latest.power || 0;

        // รีเซ็ตค่าเมื่อเช้าวันใหม่
        if (dailyPeak.date !== today) {
            dailyPeak = { date: today, maxPower: 0 };
            halfThresholdAlertSent = false;
            console.log(`🔁 Reset daily peak and 50% alert for ${today}`);
        }

        // ===== Peak Alert =====
        if (powerNow > dailyPeak.maxPower) {
            dailyPeak.maxPower = powerNow;
            console.log(`🚨 New peak ${powerNow.toFixed(2)} kW at ${latest.timestamp}`);

            await sendPushNotification(
                '⚡ New Daily Peak!',
                `Peak power today is ${powerNow.toFixed(2)} kW`,
                'peak',
                { 
                    power: powerNow, 
                    timestamp: latest.timestamp,
                    percentage: (powerNow / total_maxKW * 100).toFixed(1)
                }
            );
        }

        // ===== 50% Threshold Alert =====
        if (powerNow >= halfMaxKW && !halfThresholdAlertSent) {
            halfThresholdAlertSent = true;
            const percentage = (powerNow / total_maxKW * 100).toFixed(1);
            console.log(`⚠️ Power above 50%: ${powerNow.toFixed(2)} kW`);
            
            await sendPushNotification(
                '⚡ Power Above 50%!',
                `Current power is ${powerNow.toFixed(2)} kW (${percentage}%)`,
                'threshold',
                { 
                    power: powerNow, 
                    percentage: parseFloat(percentage),
                    threshold: halfMaxKW,
                    timestamp: latest.timestamp
                }
            );
        }

    } catch (err) {
        console.error('❌ Error checking daily peak:', err);
    }
}

// ================= API: ดูรายการ Subscriptions ทั้งหมด =================
app.get('/api/subscriptions', async (req, res) => {
    try {
        const subscriptions = await PushSubscription.find()
            .select('-keys') // ไม่แสดง keys เพื่อความปลอดภัย
            .sort({ createdAt: -1 });

        const activeCount = await PushSubscription.countDocuments({ isActive: true });
        const inactiveCount = await PushSubscription.countDocuments({ isActive: false });

        res.json({
            subscriptions,
            total: subscriptions.length,
            activeCount,
            inactiveCount
        });

    } catch (err) {
        console.error('❌ Get subscriptions error:', err);
        res.status(500).json({ error: 'Failed to get subscriptions', message: err.message });
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
