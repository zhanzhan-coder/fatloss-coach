/* 减脂教练 前端逻辑 */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

let state = null;
let password = localStorage.getItem('app_password') || '';
let chatHistory = [];

const MEAL_NAMES = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };
const MEAL_ORDER = ['breakfast', 'lunch', 'dinner', 'snack'];
const STRENGTH_TYPES = ['力量训练'];

// ---------- 工具 ----------
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2200);
}
function dstr(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function jin(kg, digits = 1) { return (kg * 2).toFixed(digits); }
function entryKcal(e) { return e.items.reduce((s, i) => s + i.kcal, 0); }
function entryProtein(e) { return e.items.reduce((s, i) => s + i.protein, 0); }
function planTargetOn(dateStr) {
  const P = state.plan;
  if (dateStr <= P[0].date) return P[0].kg;
  for (let i = 1; i < P.length; i++) {
    if (dateStr <= P[i].date) {
      const a = P[i - 1], b = P[i];
      const r = (new Date(dateStr) - new Date(a.date)) / (new Date(b.date) - new Date(a.date));
      return a.kg + (b.kg - a.kg) * r;
    }
  }
  return P[P.length - 1].kg;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-app-password': password, ...(opts.headers || {}) },
  });
  if (res.status === 401) { showAuth(); throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('请求失败 ' + res.status));
  return data;
}

// ---------- 启动 ----------
async function boot() {
  try {
    state = await api('/api/state');
  } catch (e) {
    if (e.message !== 'unauthorized') toast('连不上服务器：' + e.message);
    return;
  }
  $('#auth-screen').hidden = true;
  if (!state.profile) { $('#onboard-screen').hidden = false; return; }
  $('#onboard-screen').hidden = true;
  renderAll();
}

function showAuth() {
  $('#auth-screen').hidden = false;
  $('#auth-input').focus();
}

$('#auth-btn').onclick = () => {
  password = $('#auth-input').value.trim();
  localStorage.setItem('app_password', password);
  $('#auth-error').textContent = '';
  boot().then(() => {
    if (!$('#auth-screen').hidden) $('#auth-error').textContent = '密码不对，再试一次';
  });
};
$('#auth-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('#auth-btn').click(); });

// ---------- 资料 ----------
$('#ob-save').onclick = async () => {
  const body = {
    name: $('#ob-name').value.trim(),
    heightCm: Number($('#ob-height').value),
    weightKg: Number($('#ob-weight').value) / 2,
    goalKg: Number($('#ob-goal').value) / 2,
    age: Number($('#ob-age').value),
  };
  if (!body.heightCm || !body.weightKg || !body.goalKg || !body.age) {
    $('#ob-error').textContent = '身高、体重、目标、年龄都要填哦'; return;
  }
  try {
    await api('/api/profile', { method: 'POST', body: JSON.stringify(body) });
    state = await api('/api/state');
    $('#onboard-screen').hidden = true;
    renderAll();
    toast('已生成你的专属热量预算 🔥');
  } catch (e) { $('#ob-error').textContent = e.message; }
};

// ---------- 渲染 ----------
function renderAll() {
  const p = state.profile;
  $('#greeting').textContent = (p.name ? p.name + '，' : '') + '加油';
  $('#date-label').textContent = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });

  // 进度徽章
  const ws = [...state.weights].sort((a, b) => a.date.localeCompare(b.date));
  const badge = $('#ontrack-badge');
  if (ws.length) {
    const cur = ws[ws.length - 1].kg;
    const target = planTargetOn(dstr());
    const diff = (cur - target) * 2;
    if (Math.abs(diff) <= 1) { badge.textContent = '✅ 进度正常'; badge.className = 'good'; }
    else if (diff > 1) { badge.textContent = `⚠️ 比计划多 ${diff.toFixed(1)} 斤`; badge.className = 'bad'; }
    else { badge.textContent = `🎉 超前 ${(-diff).toFixed(1)} 斤`; badge.className = 'good'; }
  } else {
    badge.textContent = '📝 先记一次体重'; badge.className = '';
  }

  renderToday();
  renderWorkouts();
  renderWeight();
  renderMe();
}

function renderToday() {
  const today = state.serverDate;
  const logs = state.logs.filter(l => l.date === today);
  const eaten = logs.reduce((s, l) => s + entryKcal(l), 0);
  const protein = Math.round(logs.reduce((s, l) => s + entryProtein(l), 0));
  const burn = state.workouts.filter(w => w.date === today).reduce((s, w) => s + w.kcal, 0);
  const budget = state.budget.budget;
  const remain = budget - eaten;
  const pct = Math.min(1, eaten / budget);

  const color = pct > 1 ? '#e5534b' : pct > 0.85 ? '#f0a13c' : '#34b37a';
  const R = 56, C = 2 * Math.PI * R;
  $('#kcal-ring').innerHTML = `
    <svg width="128" height="128">
      <circle cx="64" cy="64" r="${R}" fill="none" stroke="#f3ece9" stroke-width="12"/>
      <circle cx="64" cy="64" r="${R}" fill="none" stroke="${color}" stroke-width="12"
        stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}"/>
    </svg>
    <div class="ring-center"><b>${Math.max(0, remain)}</b><span>还可吃 kcal</span></div>`;

  $('#today-summary').innerHTML = `
    <div class="line"><span>今日预算</span><span class="num">${budget} kcal</span></div>
    <div class="line"><span>已摄入</span><span class="num">${eaten} kcal</span></div>
    <div class="line"><span>运动消耗</span><span class="num" style="color:var(--green)">+${burn} kcal</span></div>
    <div class="line"><span>蛋白质</span><span class="num">${protein} / ${state.budget.proteinTarget} g</span></div>`;

  // 餐次分组
  const mealsEl = $('#meals');
  mealsEl.innerHTML = '';
  for (const m of MEAL_ORDER) {
    const entries = logs.filter(l => l.meal === m);
    if (!entries.length) continue;
    const block = document.createElement('div');
    block.className = 'meal-block';
    const total = entries.reduce((s, e) => s + entryKcal(e), 0);
    block.innerHTML = `<div class="meal-title"><span>${MEAL_NAMES[m]}</span><span>${total} kcal</span></div>`;
    for (const e of entries) {
      const div = document.createElement('div');
      div.className = 'entry';
      div.innerHTML = `
        <div class="foods">
          ${e.items.map(i => i.name).join('、')}
          <div class="chips">${e.items.map(i => `<span class="chip">${i.name} ${i.grams}g</span>`).join('')}</div>
        </div>
        <span class="kcal">${entryKcal(e)} kcal</span>
        <button class="del" data-id="${e.id}">✕</button>`;
      div.querySelector('.del').onclick = async () => {
        await api('/api/logs/' + e.id, { method: 'DELETE' });
        state.logs = state.logs.filter(l => l.id !== e.id);
        renderToday(); toast('已删除');
      };
      block.appendChild(div);
    }
    mealsEl.appendChild(block);
  }
  if (!logs.length) {
    mealsEl.innerHTML = '<div class="card center muted">今天还没记录饮食<br>点右下角 📷 拍一张就能记</div>';
  }
}

// ---------- 拍照 ----------
$('#fab').onclick = () => $('#photo-input').click();
$('#photo-input').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  openPhotoModal();
  try {
    const dataUrl = await compressImage(file);
    $('#photo-preview').src = dataUrl;
    const hour = new Date().getHours();
    $('#photo-meal').value = hour < 10 ? 'breakfast' : hour < 15 ? 'lunch' : hour < 21 ? 'dinner' : 'snack';
    $('#photo-status').textContent = 'AI识别中，大概需要几秒钟…';
    const result = await api('/api/analyze', { method: 'POST', body: JSON.stringify({ image: dataUrl }) });
    if (!result.items.length) {
      $('#photo-status').textContent = result.comment || '没识别出来，换一张试试';
      return;
    }
    $('#photo-status').hidden = true;
    $('#photo-result').hidden = false;
    $('#photo-comment').textContent = '💬 ' + (result.comment || '');
    renderPhotoItems(result.items);
  } catch (err) {
    $('#photo-status').textContent = err.message;
  }
};

function openPhotoModal() {
  $('#photo-modal').hidden = false;
  $('#photo-status').hidden = false;
  $('#photo-status').textContent = '处理图片中…';
  $('#photo-result').hidden = true;
  $('#photo-preview').src = '';
  $('#photo-items').innerHTML = '';
  $('#photo-comment').textContent = '';
}
$('#photo-cancel').onclick = () => { $('#photo-modal').hidden = true; };

function renderPhotoItems(items) {
  const box = $('#photo-items');
  box.innerHTML = '';
  items.forEach((it, idx) => {
    const row = document.createElement('div');
    row.className = 'photo-item';
    row.innerHTML = `
      <input value="${it.name}" data-k="name" data-i="${idx}">
      <input value="${it.grams}" type="number" data-k="grams" data-i="${idx}" title="克">
      <input value="${it.kcal}" type="number" data-k="kcal" data-i="${idx}" title="kcal">`;
    box.appendChild(row);
  });
  box._items = items;
}

$('#photo-save').onclick = async () => {
  const items = $('#photo-items')._items || [];
  $$('#photo-items input').forEach(inp => {
    const it = items[Number(inp.dataset.i)];
    const k = inp.dataset.k;
    it[k] = k === 'name' ? inp.value : Number(inp.value) || 0;
  });
  try {
    const { entry } = await api('/api/logs', {
      method: 'POST',
      body: JSON.stringify({ meal: $('#photo-meal').value, items }),
    });
    state.logs.push(entry);
    $('#photo-modal').hidden = true;
    renderToday();
    toast(`已记录，共 ${entryKcal(entry)} kcal`);
  } catch (e) { toast(e.message); }
};

async function compressImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.7);
}

// ---------- 手动记录 ----------
$('#manual-add-btn').onclick = () => {
  $('#manual-modal').hidden = false;
  const hour = new Date().getHours();
  $('#manual-meal').value = hour < 10 ? 'breakfast' : hour < 15 ? 'lunch' : hour < 21 ? 'dinner' : 'snack';
};
$('#manual-cancel').onclick = () => { $('#manual-modal').hidden = true; };
$('#manual-save').onclick = async () => {
  const name = $('#manual-name').value.trim();
  if (!name) { toast('填一下吃了什么'); return; }
  const kcal = Number($('#manual-kcal').value) || 300;
  try {
    const { entry } = await api('/api/logs', {
      method: 'POST',
      body: JSON.stringify({
        meal: $('#manual-meal').value,
        items: [{ name, grams: 0, kcal, protein: 0, carbs: 0, fat: 0 }],
      }),
    });
    state.logs.push(entry);
    $('#manual-modal').hidden = true;
    $('#manual-name').value = ''; $('#manual-kcal').value = '';
    renderToday(); toast('已记录');
  } catch (e) { toast(e.message); }
};

// ---------- 运动 ----------
const WEEK_PLAN = [
  '有氧 3~4 次：慢跑 / 跳绳 / 爬坡快走，每次 30~40 分钟',
  '力量 2~3 次：深蹲、俯卧撑、平板支撑等，宿舍可做',
  '每天 8000~10000 步（上课、拿快递尽量走路）',
  '运动日热量可以稍微吃回来一点，但别超过消耗的一半',
];

function weekStart() {
  const d = new Date();
  d.setDate(d.getDate() - (d.getDay() + 6) % 7);
  return dstr(d);
}

function renderWorkouts() {
  const ws = weekStart();
  const weekWos = state.workouts.filter(w => w.date >= ws);
  const cardio = weekWos.filter(w => w.type !== '步数' && !STRENGTH_TYPES.includes(w.type)).length;
  const strength = weekWos.filter(w => STRENGTH_TYPES.includes(w.type)).length;
  const burn = weekWos.reduce((s, w) => s + w.kcal, 0);

  $('#week-progress').innerHTML = `
    <h3>本周完成度（${ws.slice(5)} 起）</h3>
    <div class="wp-row"><span>🏃 有氧</span><span>${cardio} / 3 次</span></div>
    <div class="progress-bar"><div style="width:${Math.min(100, cardio / 3 * 100)}%"></div></div>
    <div class="wp-row"><span>💪 力量</span><span>${strength} / 2 次</span></div>
    <div class="progress-bar"><div style="width:${Math.min(100, strength / 2 * 100)}%"></div></div>
    <div class="wp-row"><span>🔥 本周运动消耗</span><span class="num">${burn} kcal</span></div>`;

  $('#week-plan').innerHTML = '<h3>本周训练计划</h3>' + WEEK_PLAN.map(t => `<div class="plan-item">· ${t}</div>`).join('');

  const list = [...state.workouts].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt).slice(0, 20);
  const box = $('#workout-list');
  box.innerHTML = list.length ? '' : '<div class="card center muted">还没有运动记录，动起来！</div>';
  for (const w of list) {
    const div = document.createElement('div');
    div.className = 'entry';
    div.innerHTML = `
      <div class="foods">${w.type}${w.minutes ? ' ' + w.minutes + '分钟' : ''}${w.steps ? ' ' + w.steps + '步' : ''}
        <div class="muted small">${w.date}</div></div>
      <span class="kcal" style="color:var(--green)">-${w.kcal} kcal</span>
      <button class="del">✕</button>`;
    div.querySelector('.del').onclick = async () => {
      await api('/api/workouts/' + w.id, { method: 'DELETE' });
      state.workouts = state.workouts.filter(x => x.id !== w.id);
      renderWorkouts(); renderToday();
    };
    box.appendChild(div);
  }
}

$('#add-workout-btn').onclick = () => {
  $('#workout-modal').hidden = false;
  $('#wo-minutes').value = ''; $('#wo-steps').value = '';
};
$('#wo-cancel').onclick = () => { $('#workout-modal').hidden = true; };
$('#wo-save').onclick = async () => {
  const steps = Number($('#wo-steps').value) || 0;
  const minutes = Number($('#wo-minutes').value) || 0;
  if (!steps && !minutes) { toast('填时长或步数至少一个'); return; }
  try {
    const { entry } = await api('/api/workouts', {
      method: 'POST',
      body: JSON.stringify({ type: $('#wo-type').value, minutes, steps }),
    });
    state.workouts.push(entry);
    $('#workout-modal').hidden = true;
    renderWorkouts(); renderToday();
    toast(`消耗约 ${entry.kcal} kcal 🔥`);
  } catch (e) { toast(e.message); }
};

// ---------- 体重 ----------
function renderWeight() {
  const ws = [...state.weights].sort((a, b) => a.date.localeCompare(b.date));
  const cur = ws.length ? ws[ws.length - 1] : null;
  const ms = state.nextMilestone;
  const targetToday = planTargetOn(dstr());

  $('#milestone-card').innerHTML = `
    <div class="ms-row"><span class="muted">当前体重</span>
      <span class="milestone-big">${cur ? jin(cur.kg) + ' 斤' : '未记录'}</span></div>
    <div class="ms-row"><span>计划要求今天约</span><b>${jin(targetToday)} 斤</b></div>
    <div class="ms-row"><span>下一节点 ${ms.date.slice(5)}</span><b>${jin(ms.kg)} 斤</b></div>
    <div class="ms-row"><span>距下一节点还差</span>
      <b style="color:${cur && cur.kg > ms.kg ? 'var(--primary-dark)' : 'var(--green)'}">
      ${cur ? Math.max(0, (cur.kg - ms.kg) * 2).toFixed(1) + ' 斤' : '-'}</b></div>`;

  const box = $('#weight-history');
  box.innerHTML = '';
  for (const w of [...ws].reverse().slice(0, 10)) {
    const div = document.createElement('div');
    div.className = 'entry';
    div.innerHTML = `<div class="foods">${w.date}</div><span class="kcal">${jin(w.kg)} 斤</span>
      <button class="del">✕</button>`;
    div.querySelector('.del').onclick = async () => {
      await api('/api/weights/' + w.id, { method: 'DELETE' });
      state.weights = state.weights.filter(x => x.id !== w.id);
      renderWeight();
    };
    box.appendChild(div);
  }
  drawChart(ws);
}

$('#weight-save').onclick = async () => {
  const v = Number($('#weight-input').value);
  if (!v || v < 60 || v > 400) { toast('体重数值看着不对哦'); return; }
  const date = $('#weight-date').value || undefined;
  try {
    await api('/api/weights', { method: 'POST', body: JSON.stringify({ kg: v / 2, date }) });
    state = await api('/api/state');
    $('#weight-input').value = '';
    $('#weight-date').value = '';
    renderAll();
    toast('已记录，继续加油 ⚖️');
  } catch (e) { toast(e.message); }
};

function drawChart(weights) {
  const canvas = $('#weight-chart');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 320, H = 220;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const P = state.plan;
  const x0 = new Date(P[0].date), x1 = new Date(P[P.length - 1].date);
  const allKg = P.map(p => p.kg).concat(weights.map(w => w.kg));
  const yMin = Math.floor(Math.min(...allKg)) - 1, yMax = Math.ceil(Math.max(...allKg)) + 1;
  const pad = { l: 36, r: 10, t: 10, b: 24 };
  const X = d => pad.l + (new Date(d) - x0) / (x1 - x0) * (W - pad.l - pad.r);
  const Y = kg => pad.t + (1 - (kg - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);

  // y轴刻度
  ctx.font = '10px sans-serif'; ctx.fillStyle = '#b8aca6'; ctx.textAlign = 'right';
  for (let kg = yMin + 1; kg < yMax; kg += 2) {
    ctx.fillText((kg * 2) + '斤', pad.l - 4, Y(kg) + 3);
    ctx.strokeStyle = '#f5ece8';
    ctx.beginPath(); ctx.moveTo(pad.l, Y(kg)); ctx.lineTo(W - pad.r, Y(kg)); ctx.stroke();
  }
  // 月份刻度
  ctx.textAlign = 'center';
  for (const p of P) {
    ctx.fillText(p.date.slice(5), X(p.date), H - 8);
  }
  // 计划线
  ctx.setLineDash([5, 4]); ctx.strokeStyle = '#c9b8b0'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  P.forEach((p, i) => i ? ctx.lineTo(X(p.date), Y(p.kg)) : ctx.moveTo(X(p.date), Y(p.kg)));
  ctx.stroke(); ctx.setLineDash([]);
  // 实际体重
  if (weights.length) {
    ctx.strokeStyle = '#ff7a59'; ctx.lineWidth = 2.5;
    ctx.beginPath();
    weights.forEach((w, i) => i ? ctx.lineTo(X(w.date), Y(w.kg)) : ctx.moveTo(X(w.date), Y(w.kg)));
    ctx.stroke();
    ctx.fillStyle = '#ff7a59';
    for (const w of weights) {
      ctx.beginPath(); ctx.arc(X(w.date), Y(w.kg), 3.5, 0, 7); ctx.fill();
    }
  }
  // 今天竖线
  const tx = X(dstr());
  ctx.strokeStyle = '#ffd4c4';
  ctx.beginPath(); ctx.moveTo(tx, pad.t); ctx.lineTo(tx, H - pad.b); ctx.stroke();
}

// ---------- 教练 ----------
function addMsg(text, who) {
  const div = document.createElement('div');
  div.className = 'msg ' + who;
  div.textContent = text;
  $('#chat-box').appendChild(div);
  div.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return div;
}

async function askCoach(question) {
  const typing = addMsg('教练思考中…', 'coach typing');
  try {
    const { reply } = await api('/api/coach', { method: 'POST', body: JSON.stringify({ question }) });
    typing.remove();
    addMsg(reply, 'coach');
  } catch (e) {
    typing.remove();
    addMsg('出错了：' + e.message, 'coach');
  }
}

$('#coach-quick-btn').onclick = () => { switchTab('coach'); askCoach(); };
$('#chat-send').onclick = () => {
  const q = $('#chat-input').value.trim();
  if (!q) return;
  $('#chat-input').value = '';
  addMsg(q, 'user');
  askCoach(q);
};
$('#chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('#chat-send').click(); });

// ---------- 我的 ----------
function renderMe() {
  const p = state.profile, b = state.budget;
  $('#profile-card').innerHTML = `
    <h3>我的资料</h3>
    <div class="ms-row"><span>身高</span><b>${p.heightCm} cm</b></div>
    <div class="ms-row"><span>当前体重</span><b>${jin(p.weightKg)} 斤</b></div>
    <div class="ms-row"><span>目标体重</span><b>${jin(p.goalKg)} 斤</b></div>
    <div class="ms-row"><span>年龄</span><b>${p.age} 岁</b></div>`;
  $('#budget-card').innerHTML = `
    <h3>我的每日预算</h3>
    <div class="ms-row"><span>基础代谢</span><b>${b.bmr} kcal</b></div>
    <div class="ms-row"><span>日常消耗(TDEE)</span><b>${b.tdee} kcal</b></div>
    <div class="ms-row"><span>减脂期预算</span><b style="color:var(--primary-dark)">${b.budget} kcal</b></div>
    <div class="ms-row"><span>蛋白质目标</span><b>${b.proteinTarget} g</b></div>
    <p class="muted small" style="margin-top:8px">预算会随你记录的体重自动更新。想改资料？重新记录一次体重即可更新体重项。</p>`;
  $('#ai-status').textContent = state.aiEnabled
    ? '✅ AI识别与教练功能已启用'
    : '⚠️ 未配置 GLM_API_KEY，拍照识别和教练功能暂不可用';
}

$('#export-btn').onclick = () => {
  const blob = new Blob([JSON.stringify({
    profile: state.profile, logs: state.logs, weights: state.weights, workouts: state.workouts,
  }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '减脂数据-' + dstr() + '.json';
  a.click();
};

// ---------- 导航 ----------
function switchTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
  $$('#tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'weight') renderWeight();
  window.scrollTo(0, 0);
}
$$('#tabbar button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));

window.addEventListener('resize', () => { if (state && state.profile) renderWeight(); });

boot();
