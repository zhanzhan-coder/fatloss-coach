const express = require('express');
const fs = require('fs');
const path = require('path');

// ---------- 配置 ----------
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
const PORT = Number(process.env.PORT || 3000);
const GLM_API_KEY = process.env.GLM_API_KEY || '';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const DATA_FILE = path.join(__dirname, 'data.json');

// ---------- 存储：有 DATABASE_URL 用云端 Postgres（部署用），否则用本地 data.json ----------
const DATABASE_URL = process.env.DATABASE_URL || '';
let db = { profile: null, logs: [], weights: [], workouts: [] };
let pgClient = null;
let saveTimer = null;

async function initStore() {
  if (!DATABASE_URL) {
    if (fs.existsSync(DATA_FILE)) {
      try { Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch {}
    }
    console.log('存储模式：本地文件 data.json');
    return;
  }
  const { Client } = require('pg');
  pgClient = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();
  await pgClient.query('CREATE TABLE IF NOT EXISTS store (id integer PRIMARY KEY, data jsonb NOT NULL)');
  const r = await pgClient.query('SELECT data FROM store WHERE id = 1');
  if (r.rows.length) Object.assign(db, r.rows[0].data);
  console.log('存储模式：PostgreSQL 云端数据库');
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (pgClient) {
      pgClient.query(
        'INSERT INTO store (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET data = $1::jsonb',
        [JSON.stringify(db)]
      ).catch(e => console.error('保存失败:', e.message));
    } else {
      fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
    }
  }, 200);
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function dstr(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ---------- 减脂里程碑计划（kg），与和用户确认的进度一致 ----------
const PLAN = [
  { date: '2026-10-12', kg: 74.0 },
  { date: '2026-10-31', kg: 73.0 },
  { date: '2026-11-30', kg: 71.0 },
  { date: '2026-12-31', kg: 68.5 },
  { date: '2027-01-31', kg: 66.5 },
  { date: '2027-02-28', kg: 64.5 },
  { date: '2027-03-31', kg: 62.2 },
  { date: '2027-04-15', kg: 60.5 },
  { date: '2027-05-20', kg: 60.0 },
  { date: '2027-07-01', kg: 55.0 },
];

function planTargetOn(dateStr) {
  if (dateStr <= PLAN[0].date) return PLAN[0].kg;
  for (let i = 1; i < PLAN.length; i++) {
    if (dateStr <= PLAN[i].date) {
      const a = PLAN[i - 1], b = PLAN[i];
      const r = (new Date(dateStr) - new Date(a.date)) / (new Date(b.date) - new Date(a.date));
      return a.kg + (b.kg - a.kg) * r;
    }
  }
  return PLAN[PLAN.length - 1].kg;
}

function nextMilestone(dateStr) {
  for (const p of PLAN) if (p.date >= dateStr) return p;
  return PLAN[PLAN.length - 1];
}

function calcBudget(p) {
  const bmr = 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.age - 161; // Mifflin-St Jeor（女）
  const tdee = bmr * 1.4; // 轻度活动的大学生
  return {
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    budget: Math.max(1100, Math.round(tdee - 450)),
    proteinTarget: Math.round(p.goalKg * 1.8),
  };
}

// 运动MET表：kcal = MET × 体重kg × 小时
const METS = {
  '跑步': 8, '跳绳': 11, '快走': 3.5, '游泳': 6, '骑车': 6,
  '跳操/HIIT': 7, '羽毛球': 5.5, '力量训练': 5, '瑜伽': 3, '其他': 5,
};
const STRENGTH_TYPES = ['力量训练'];

function latestWeightKg() {
  if (db.weights.length) {
    const w = [...db.weights].sort((a, b) => a.date.localeCompare(b.date));
    return w[w.length - 1].kg;
  }
  return db.profile ? db.profile.weightKg : 70;
}

// ---------- GLM API ----------
async function glmChat(messages, model) {
  const res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GLM_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature: 0.3 }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error('GLM API 错误: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  return data.choices[0].message.content;
}

function parseJsonLoose(text) {
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('AI返回格式异常');
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ---------- HTTP ----------
const app = express();
app.use(express.json({ limit: '12mb' }));

app.use('/api', (req, res, next) => {
  if (!APP_PASSWORD || req.headers['x-app-password'] === APP_PASSWORD) return next();
  res.status(401).json({ error: '密码错误或未提供' });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', (req, res) => {
  const today = dstr();
  res.json({
    profile: db.profile,
    budget: db.profile ? calcBudget(db.profile) : null,
    plan: PLAN,
    planTodayKg: Math.round(planTargetOn(today) * 10) / 10,
    nextMilestone: nextMilestone(today),
    logs: db.logs,
    weights: db.weights,
    workouts: db.workouts,
    serverDate: today,
    aiEnabled: Boolean(GLM_API_KEY),
  });
});

app.post('/api/profile', (req, res) => {
  const { name, heightCm, weightKg, goalKg, age } = req.body || {};
  if (!heightCm || !weightKg || !goalKg || !age) return res.status(400).json({ error: '信息不完整' });
  db.profile = {
    name: String(name || '').slice(0, 20),
    heightCm: Number(heightCm), weightKg: Number(weightKg),
    goalKg: Number(goalKg), age: Number(age),
  };
  save();
  res.json({ ok: true, budget: calcBudget(db.profile) });
});

app.post('/api/logs', (req, res) => {
  const { date, meal, items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: '没有食物条目' });
  const clean = items.map(it => ({
    name: String(it.name || '未知食物').slice(0, 30),
    grams: Number(it.grams) || 0,
    kcal: Math.round(Number(it.kcal) || 0),
    protein: Math.round((Number(it.protein) || 0) * 10) / 10,
    carbs: Math.round((Number(it.carbs) || 0) * 10) / 10,
    fat: Math.round((Number(it.fat) || 0) * 10) / 10,
  }));
  const entry = { id: uid(), date: date || dstr(), meal: meal || 'snack', items: clean, createdAt: Date.now() };
  db.logs.push(entry);
  save();
  res.json({ ok: true, entry });
});

app.delete('/api/logs/:id', (req, res) => {
  db.logs = db.logs.filter(l => l.id !== req.params.id);
  save();
  res.json({ ok: true });
});

app.post('/api/workouts', (req, res) => {
  const { date, type, minutes, steps, note } = req.body || {};
  const kg = latestWeightKg();
  let kcal = 0;
  if (steps) {
    kcal = Math.round(Number(steps) * kg * 0.0005);
  } else {
    const met = METS[type] || METS['其他'];
    kcal = Math.round(met * kg * (Number(minutes) || 0) / 60);
  }
  const entry = {
    id: uid(), date: date || dstr(),
    type: steps ? '步数' : (METS[type] ? type : '其他'),
    minutes: Number(minutes) || 0,
    steps: Number(steps) || 0,
    kcal, note: String(note || '').slice(0, 50), createdAt: Date.now(),
  };
  db.workouts.push(entry);
  save();
  res.json({ ok: true, entry });
});

app.delete('/api/workouts/:id', (req, res) => {
  db.workouts = db.workouts.filter(w => w.id !== req.params.id);
  save();
  res.json({ ok: true });
});

app.post('/api/weights', (req, res) => {
  const { date, kg } = req.body || {};
  const num = Number(kg);
  if (!num || num < 30 || num > 200) return res.status(400).json({ error: '体重数值异常' });
  const d = date || dstr();
  const existing = db.weights.find(w => w.date === d);
  if (existing) existing.kg = num;
  else db.weights.push({ id: uid(), date: d, kg: num });
  if (db.profile) {
    const sorted = [...db.weights].sort((a, b) => a.date.localeCompare(b.date));
    db.profile.weightKg = sorted[sorted.length - 1].kg;
  }
  save();
  res.json({ ok: true });
});

app.delete('/api/weights/:id', (req, res) => {
  db.weights = db.weights.filter(w => w.id !== req.params.id);
  save();
  res.json({ ok: true });
});

app.post('/api/analyze', async (req, res) => {
  if (!GLM_API_KEY) return res.status(503).json({ error: '服务器还没配置 GLM_API_KEY，先在 .env 里填好 Key 再试' });
  const { image } = req.body || {};
  if (!image || !image.startsWith('data:image')) return res.status(400).json({ error: '图片数据异常' });
  try {
    const prompt = '你是专业营养师。请识别这张照片里的所有食物，逐一估算重量(克)、热量(kcal)、蛋白质/碳水/脂肪(克)。' +
      '只返回JSON，不要任何其他文字，不要用markdown代码块，格式：' +
      '{"items":[{"name":"米饭","grams":150,"kcal":174,"protein":4,"carbs":38,"fat":0.5}],"comment":"一句50字以内的教练口吻中文点评"}。' +
      '如果看不清或图中没有食物，返回 {"items":[],"comment":"没看清，换个角度、光线好一点再拍一张吧"}';
    const content = await glmChat([
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: image } },
        { type: 'text', text: prompt },
      ] },
    ], 'glm-4v-flash');
    const parsed = parseJsonLoose(content);
    parsed.items = (parsed.items || []).map(it => ({
      name: String(it.name || '未知食物'),
      grams: Math.round(Number(it.grams) || 0),
      kcal: Math.round(Number(it.kcal) || 0),
      protein: Math.round((Number(it.protein) || 0) * 10) / 10,
      carbs: Math.round((Number(it.carbs) || 0) * 10) / 10,
      fat: Math.round((Number(it.fat) || 0) * 10) / 10,
    }));
    res.json(parsed);
  } catch (e) {
    res.status(502).json({ error: '识别失败：' + e.message });
  }
});

app.post('/api/coach', async (req, res) => {
  if (!GLM_API_KEY) return res.status(503).json({ error: '服务器还没配置 GLM_API_KEY，先在 .env 里填好 Key 再试' });
  const p = db.profile;
  if (!p) return res.status(400).json({ error: '请先完善个人资料' });
  const today = dstr();
  const b = calcBudget(p);
  const todayLogs = db.logs.filter(l => l.date === today);
  const inKcal = todayLogs.reduce((s, l) => s + l.items.reduce((x, i) => x + i.kcal, 0), 0);
  const inProtein = Math.round(todayLogs.reduce((s, l) => s + l.items.reduce((x, i) => x + i.protein, 0), 0));
  const todayWorkouts = db.workouts.filter(w => w.date === today);
  const burn = todayWorkouts.reduce((s, w) => s + w.kcal, 0);
  const foods = todayLogs.map(l => l.items.map(i => i.name).join('、')).join('；') || '还没记录';
  const ws = [...db.weights].sort((a, b2) => a.date.localeCompare(b2.date));
  const lastW = ws.length ? ws[ws.length - 1] : null;
  const ms = nextMilestone(today);

  const system = [
    '你是用户的私人减脂教练，语气像微信里的私教：严格但会鼓励人，回答简短、具体、可执行，用中文，不要用markdown格式。',
    `用户资料：女，大学生，${p.age}岁，${p.heightCm}cm，当前${(p.weightKg * 2).toFixed(0)}斤，最终目标${(p.goalKg * 2).toFixed(0)}斤。`,
    '中期目标：2027年4月体测前到120斤；当前阶段每周减约1.1斤。',
    `每日热量预算${b.budget}kcal，蛋白质目标${b.proteinTarget}g。`,
    `今天已摄入${inKcal}kcal（蛋白质${inProtein}g），运动消耗${burn}kcal（${todayWorkouts.map(w => w.type + (w.minutes ? w.minutes + '分钟' : w.steps + '步')).join('、') || '还没运动'}）。`,
    `今天吃了：${foods}。`,
    `最近一次称重：${lastW ? lastW.date + ' ' + (lastW.kg * 2).toFixed(1) + '斤' : '还没有记录'}；计划要求现在约${(planTargetOn(today) * 2).toFixed(1)}斤；下一节点${ms.date}目标${(ms.kg * 2).toFixed(1)}斤。`,
    '点评结构：先肯定做得好的地方，再指出1-2个具体问题，最后给1个明天就能执行的建议。150字以内。',
  ].join('\n');

  const question = (req.body && req.body.question) || '请点评一下我今天的表现';
  try {
    const reply = await glmChat([
      { role: 'system', content: system },
      { role: 'user', content: String(question).slice(0, 500) },
    ], 'glm-4-flash');
    res.json({ reply });
  } catch (e) {
    res.status(502).json({ error: '教练回复失败：' + e.message });
  }
});

initStore().then(() => {
  app.listen(PORT, () => {
    console.log(`减脂教练已启动: http://localhost:${PORT}`);
    if (!GLM_API_KEY) console.log('提示：还没配置 GLM_API_KEY，AI识别和教练功能暂不可用（见 README）');
  });
}).catch(e => {
  console.error('数据库连接失败：', e.message);
  process.exit(1);
});
