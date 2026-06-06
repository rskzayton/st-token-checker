/**
 * Token 统计 (实时计价) — SillyTavern 第三方扩展
 * 实时统计输入/输出/合计 Token，按人民币计价，支持缓存效率、吞吐量与趋势图。
 */

const EXT_ID = 'st-token-checker';
const EXT_PATH = `third-party/${EXT_ID}`;
const LS_DATA = 'st_token_counter_data_v1';     // 每对话统计数据
const LS_CONF = 'st_token_counter_conf_v1';     // 配置（价格/开关/面板位置）
const MAX_TREND = 20;                            // 趋势图保留最近请求数

// ── 默认定价（人民币 ¥ / 百万 token，按官方美元价 × 约 7.2 汇率折算）────────────
// 用户可在设置面板修改；匹配规则为「模型名包含 key」，从上到下取首个命中。
const DEFAULT_PRICING = {
    'deepseek-chat':     { input: 2.0,  cacheRead: 0.5,  cacheWrite: 2.0,  output: 8.0 },
    'deepseek-reasoner': { input: 4.0,  cacheRead: 1.0,  cacheWrite: 4.0,  output: 16.0 },
    'deepseek':          { input: 2.0,  cacheRead: 0.5,  cacheWrite: 2.0,  output: 8.0 },
    'claude-3-5-haiku':  { input: 5.76, cacheRead: 0.58, cacheWrite: 7.2,  output: 28.8 },
    'claude-3-haiku':    { input: 1.8,  cacheRead: 0.18, cacheWrite: 2.16, output: 9.0 },
    'sonnet':            { input: 21.6, cacheRead: 2.16, cacheWrite: 27.0, output: 108.0 },
    'opus':              { input: 108.0,cacheRead: 10.8, cacheWrite: 135.0,output: 540.0 },
    'claude':            { input: 21.6, cacheRead: 2.16, cacheWrite: 27.0, output: 108.0 },
    'gpt-4o-mini':       { input: 1.08, cacheRead: 0.54, cacheWrite: 1.08, output: 4.32 },
    'gpt-4o':            { input: 18.0, cacheRead: 9.0,  cacheWrite: 18.0, output: 72.0 },
    'gpt-4.1-mini':      { input: 2.88, cacheRead: 0.72, cacheWrite: 2.88, output: 11.52 },
    'gpt-4.1':           { input: 14.4, cacheRead: 3.6,  cacheWrite: 14.4, output: 57.6 },
    'gpt':               { input: 18.0, cacheRead: 9.0,  cacheWrite: 18.0, output: 72.0 },
};
const FALLBACK_PRICE = { input: 10.0, cacheRead: 2.5, cacheWrite: 12.5, output: 40.0 };

// ── 配置（持久化于 localStorage）────────────────────────────────────────────
function defaultConf() {
    return {
        pricing: structuredClone(DEFAULT_PRICING),
        fallback: structuredClone(FALLBACK_PRICE),
        panelVisible: true,
        collapsed: false,
        pos: { left: null, top: null },
        trendCount: MAX_TREND,
    };
}
let conf = loadConf();

function loadConf() {
    try {
        const raw = localStorage.getItem(LS_CONF);
        if (!raw) return defaultConf();
        return { ...defaultConf(), ...JSON.parse(raw) };
    } catch { return defaultConf(); }
}
function saveConf() {
    try { localStorage.setItem(LS_CONF, JSON.stringify(conf)); } catch {}
}

// ── 每对话统计数据（持久化于 localStorage）──────────────────────────────────
function loadAllData() {
    try { return JSON.parse(localStorage.getItem(LS_DATA) || '{}'); } catch { return {}; }
}
let allData = loadAllData();
let saveTimer = null;
function saveData() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try { localStorage.setItem(LS_DATA, JSON.stringify(allData)); } catch {}
    }, 400);
}
function emptyStat() {
    return {
        totalIn: 0, totalOut: 0, totalCacheRead: 0, totalCacheWrite: 0,
        totalCost: 0, totalSaved: 0, reqCount: 0,
        last: null,            // 最近一次请求 { in,out,total,cost,tps,source,model }
        trend: [],             // 最近 N 次合计 token
    };
}
function curChatId() {
    try { return SillyTavern.getContext().getCurrentChatId() || '__no_chat__'; }
    catch { return '__no_chat__'; }
}
function curStat() {
    const id = curChatId();
    if (!allData[id]) allData[id] = emptyStat();
    return allData[id];
}

// ── 工具：紧凑中文数字 & 金额格式 ───────────────────────────────────────────
function formatCN(n) {
    n = Number(n) || 0;
    if (n < 10000) return String(Math.round(n));
    if (n < 1e8) return (n / 1e4).toFixed(1) + '万';
    return (n / 1e8).toFixed(1) + '亿';
}
function fmtMoney(v, digits = 4) {
    v = Number(v) || 0;
    if (v >= 1) return '¥' + v.toFixed(2);
    return '¥' + v.toFixed(digits);
}

// ── 定价匹配 ────────────────────────────────────────────────────────────────
function priceFor(model) {
    const m = String(model || '').toLowerCase();
    for (const key of Object.keys(conf.pricing)) {
        if (m.includes(key.toLowerCase())) return conf.pricing[key];
    }
    return conf.fallback;
}

// ── usage 归一化（兼容 OpenAI / Claude / DeepSeek）──────────────────────────
function normalizeUsage(u) {
    if (!u || typeof u !== 'object') return null;
    const input = u.prompt_tokens ?? u.input_tokens ?? 0;
    const output = u.completion_tokens ?? u.output_tokens ?? 0;
    let cacheRead =
        u.prompt_tokens_details?.cached_tokens ??   // OpenAI
        u.cache_read_input_tokens ??                // Claude
        u.prompt_cache_hit_tokens ??                // DeepSeek
        0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0; // Claude

    // DeepSeek 的 input 已含命中+未命中；Claude 的 input_tokens 不含 cache_read，需补回
    let normIn = input;
    if (u.input_tokens != null && (u.cache_read_input_tokens || u.cache_creation_input_tokens)) {
        normIn = input + cacheRead + cacheWrite; // Claude：真实总输入 = 新输入 + 缓存读 + 缓存写
    }
    if (!normIn && !output) return null;
    return {
        input: normIn,
        output,
        cacheRead,
        cacheWrite,
        total: normIn + output,
    };
}

// ── 计价与节省 ──────────────────────────────────────────────────────────────
function computeCost(usage, model) {
    const p = priceFor(model);
    const freshIn = Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite);
    const cost =
        (freshIn * p.input +
         usage.cacheRead * p.cacheRead +
         usage.cacheWrite * p.cacheWrite +
         usage.output * p.output) / 1e6;
    // 若这些缓存读 token 按原价计算会多花多少 → 即节省金额
    const saved = (usage.cacheRead * (p.input - p.cacheRead)) / 1e6;
    return { cost, saved };
}

// ── 缓存效率评分 ────────────────────────────────────────────────────────────
function cacheGrade(cacheRead, input) {
    if (!input) return { label: '—', cls: 'tc-grade-none', rate: 0 };
    const rate = cacheRead / input;
    if (rate >= 0.70) return { label: '优秀', cls: 'tc-grade-excellent', rate };
    if (rate >= 0.40) return { label: '良好', cls: 'tc-grade-good', rate };
    if (rate >= 0.15) return { label: '一般', cls: 'tc-grade-fair', rate };
    return { label: '较低', cls: 'tc-grade-low', rate };
}

// ── 记录一次请求 ────────────────────────────────────────────────────────────
function recordRequest(usage, model, elapsedMs, source) {
    const stat = curStat();
    const { cost, saved } = computeCost(usage, model);
    const tps = elapsedMs > 0 ? usage.output / (elapsedMs / 1000) : 0;

    stat.totalIn += usage.input;
    stat.totalOut += usage.output;
    stat.totalCacheRead += usage.cacheRead;
    stat.totalCacheWrite += usage.cacheWrite;
    stat.totalCost += cost;
    stat.totalSaved += saved;
    stat.reqCount += 1;
    stat.last = {
        in: usage.input, out: usage.output, total: usage.total,
        cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
        cost, saved, tps, source, model,
    };
    stat.trend.push(usage.total);
    if (stat.trend.length > MAX_TREND) stat.trend.shift();

    saveData();
    renderPanel();
}

// ════════════════════════════════════════════════════════════════════════════
// fetch 拦截器：精确读取 API 真实 usage（含缓存），失败回退估算
// ════════════════════════════════════════════════════════════════════════════
const GEN_RE = /\/(backends\/(chat|text)-completions|generate)/i;
const originalFetch = window.fetch.bind(window);

window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    const isGen = GEN_RE.test(url) && url.includes('generate');
    const startTs = isGen ? performance.now() : 0;

    // 请求体（用于回退估算输入）
    let reqBody = null;
    if (isGen) {
        try {
            const init = args[1];
            if (init && typeof init.body === 'string') reqBody = JSON.parse(init.body);
        } catch {}
    }

    const response = await originalFetch(...args);

    if (isGen && response.ok) {
        // 克隆后异步处理，绝不消费/阻塞原始响应
        const clone = response.clone();
        const ct = (response.headers.get('content-type') || '').toLowerCase();
        const isStream = ct.includes('event-stream') || ct.includes('stream');
        handleGenResponse(clone, isStream, reqBody, startTs).catch(() => {});
    }
    return response;
};

async function handleGenResponse(resp, isStream, reqBody, startTs) {
    let rawUsage = null;
    let assistantText = '';

    if (isStream) {
        const r = await readStream(resp);
        rawUsage = r.usage;
        assistantText = r.text;
    } else {
        try {
            const json = await resp.json();
            rawUsage = extractUsage(json);
            assistantText = extractText(json);
        } catch {}
    }

    const model = detectModel(reqBody, rawUsage);
    const elapsed = performance.now() - startTs;

    let usage = normalizeUsage(rawUsage);
    let source = '精确';

    if (!usage) {
        // 回退：估算输入（请求 messages）与输出（已捕获文本）
        usage = await estimateUsage(reqBody, assistantText);
        source = '估算';
    }
    if (usage && usage.total > 0) recordRequest(usage, model, elapsed, source);
}

// 解析 SSE 流：累积 usage 与 assistant 文本，兼容 OpenAI/DeepSeek/Claude
async function readStream(resp) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage = {};
    let text = '';

    const mergeUsage = (u) => {
        if (!u) return;
        for (const k of Object.keys(u)) {
            const v = u[k];
            if (typeof v === 'number' && v > 0) usage[k] = v;
            else if (typeof v === 'object' && v) {
                usage[k] = { ...(usage[k] || {}), ...v };
            }
        }
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            const s = line.trim();
            if (!s.startsWith('data:')) continue;
            const payload = s.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let obj;
            try { obj = JSON.parse(payload); } catch { continue; }

            // usage 可能在顶层、message 内、或 Claude 的 message_delta
            mergeUsage(obj.usage);
            mergeUsage(obj.message?.usage);

            // 累积输出文本（回退估算用）
            const d = obj.choices?.[0]?.delta;
            if (d?.content) text += d.content;
            if (obj.type === 'content_block_delta' && obj.delta?.text) text += obj.delta.text;
        }
    }
    return { usage: Object.keys(usage).length ? usage : null, text };
}

function extractUsage(json) {
    return json?.usage || json?.message?.usage || null;
}
function extractText(json) {
    return json?.choices?.[0]?.message?.content
        || json?.content?.[0]?.text
        || json?.message?.content
        || '';
}
function detectModel(reqBody, rawUsage) {
    try {
        const ctx = SillyTavern.getContext();
        return reqBody?.model
            || (ctx.getChatCompletionModel && ctx.getChatCompletionModel())
            || ctx.getTokenizerModel?.()
            || 'unknown';
    } catch {
        return reqBody?.model || 'unknown';
    }
}

async function estimateUsage(reqBody, assistantText) {
    try {
        const ctx = SillyTavern.getContext();
        const count = ctx.getTokenCountAsync;
        let input = 0, output = 0;
        if (reqBody?.messages && Array.isArray(reqBody.messages)) {
            const joined = reqBody.messages
                .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
                .join('\n');
            input = await count(joined);
        } else if (typeof reqBody?.prompt === 'string') {
            input = await count(reqBody.prompt);
        }
        if (assistantText) output = await count(assistantText);
        if (!input && !output) return null;
        return { input, output, cacheRead: 0, cacheWrite: 0, total: input + output };
    } catch { return null; }
}

// ════════════════════════════════════════════════════════════════════════════
// 浮动面板 UI
// ════════════════════════════════════════════════════════════════════════════
const PANEL_ID = 'tc-panel';

function buildPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const el = document.createElement('div');
    el.id = PANEL_ID;
    el.className = 'tc-panel';
    el.innerHTML = `
        <div class="tc-header" id="tc-header">
            <span class="tc-title">📊 Token 统计</span>
            <span class="tc-actions">
                <span class="tc-btn" id="tc-collapse" title="折叠/展开">▁</span>
                <span class="tc-btn" id="tc-close" title="隐藏面板">✕</span>
            </span>
        </div>
        <div class="tc-body" id="tc-body">
            <div class="tc-model" id="tc-model">模型：—</div>
            <div class="tc-section-title">本次请求 <span class="tc-source" id="tc-source"></span></div>
            <div class="tc-grid">
                <div><span class="tc-k">输入</span><span class="tc-v" id="tc-cur-in">0</span></div>
                <div><span class="tc-k">输出</span><span class="tc-v" id="tc-cur-out">0</span></div>
                <div><span class="tc-k">合计</span><span class="tc-v" id="tc-cur-total">0</span></div>
                <div><span class="tc-k">费用</span><span class="tc-v tc-cost" id="tc-cur-cost">¥0</span></div>
                <div><span class="tc-k">吞吐</span><span class="tc-v" id="tc-cur-tps">0 tok/s</span></div>
                <div><span class="tc-k">缓存</span><span class="tc-v tc-grade" id="tc-grade">—</span></div>
            </div>
            <div class="tc-section-title">本对话累计</div>
            <div class="tc-grid">
                <div><span class="tc-k">输入</span><span class="tc-v" id="tc-tot-in">0</span></div>
                <div><span class="tc-k">输出</span><span class="tc-v" id="tc-tot-out">0</span></div>
                <div><span class="tc-k">请求</span><span class="tc-v" id="tc-tot-req">0</span></div>
                <div><span class="tc-k">总费用</span><span class="tc-v tc-cost" id="tc-tot-cost">¥0</span></div>
                <div class="tc-wide"><span class="tc-k">已节省</span><span class="tc-v tc-saved" id="tc-tot-saved">¥0</span></div>
            </div>
            <div class="tc-section-title">最近 ${MAX_TREND} 次趋势</div>
            <canvas id="tc-trend" class="tc-trend" width="240" height="56"></canvas>
        </div>`;
    document.body.appendChild(el);

    // 恢复位置
    if (conf.pos.left != null) { el.style.left = conf.pos.left + 'px'; el.style.top = conf.pos.top + 'px'; el.style.right = 'auto'; }
    if (conf.collapsed) el.classList.add('tc-collapsed');
    if (!conf.panelVisible) el.style.display = 'none';

    document.getElementById('tc-collapse').onclick = () => {
        el.classList.toggle('tc-collapsed');
        conf.collapsed = el.classList.contains('tc-collapsed');
        saveConf();
    };
    document.getElementById('tc-close').onclick = () => {
        el.style.display = 'none';
        conf.panelVisible = false;
        saveConf();
    };
    makeDraggable(el, document.getElementById('tc-header'));
    renderPanel();
}

function makeDraggable(el, handle) {
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    handle.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('tc-btn')) return;
        dragging = true;
        const r = el.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
        el.style.right = 'auto';
        document.body.style.userSelect = 'none';
    });
    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const nl = Math.max(0, ox + e.clientX - sx);
        const nt = Math.max(0, oy + e.clientY - sy);
        el.style.left = nl + 'px';
        el.style.top = nt + 'px';
    });
    window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        document.body.style.userSelect = '';
        const r = el.getBoundingClientRect();
        conf.pos = { left: Math.round(r.left), top: Math.round(r.top) };
        saveConf();
    });
}

function setText(id, t) { const e = document.getElementById(id); if (e) e.textContent = t; }

function renderPanel() {
    if (!document.getElementById(PANEL_ID)) return;
    const stat = curStat();
    const last = stat.last;

    if (last) {
        setText('tc-model', '模型：' + (last.model || '—'));
        const src = document.getElementById('tc-source');
        if (src) { src.textContent = last.source === '估算' ? '（估算）' : '（精确）'; src.className = 'tc-source ' + (last.source === '估算' ? 'tc-src-est' : 'tc-src-exact'); }
        setText('tc-cur-in', formatCN(last.in));
        setText('tc-cur-out', formatCN(last.out));
        setText('tc-cur-total', formatCN(last.total));
        setText('tc-cur-cost', fmtMoney(last.cost));
        setText('tc-cur-tps', (last.tps ? last.tps.toFixed(1) : '0') + ' tok/s');
        const g = cacheGrade(last.cacheRead, last.in);
        const ge = document.getElementById('tc-grade');
        if (ge) { ge.textContent = `${g.label} ${(g.rate * 100).toFixed(0)}%`; ge.className = 'tc-v tc-grade ' + g.cls; }
    }
    setText('tc-tot-in', formatCN(stat.totalIn));
    setText('tc-tot-out', formatCN(stat.totalOut));
    setText('tc-tot-req', String(stat.reqCount));
    setText('tc-tot-cost', fmtMoney(stat.totalCost, 2));
    setText('tc-tot-saved', fmtMoney(stat.totalSaved, 2));
    drawTrend(stat.trend);
}

function drawTrend(trend) {
    const cv = document.getElementById('tc-trend');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    if (!trend || !trend.length) {
        ctx.fillStyle = '#888'; ctx.font = '11px sans-serif';
        ctx.fillText('暂无数据', W / 2 - 24, H / 2 + 4);
        return;
    }
    const max = Math.max(...trend, 1);
    const n = trend.length;
    const gap = 2;
    const bw = Math.max(2, (W - gap * (n - 1)) / n);
    for (let i = 0; i < n; i++) {
        const h = Math.max(1, (trend[i] / max) * (H - 4));
        const x = i * (bw + gap);
        const y = H - h;
        const ratio = trend[i] / max;
        ctx.fillStyle = `rgba(88,166,255,${0.45 + ratio * 0.55})`;
        ctx.fillRect(x, y, bw, h);
    }
}

function showPanel() {
    const el = document.getElementById(PANEL_ID);
    if (el) { el.style.display = ''; conf.panelVisible = true; saveConf(); }
}
function togglePanel() {
    const el = document.getElementById(PANEL_ID);
    if (!el) return;
    const vis = el.style.display !== 'none';
    el.style.display = vis ? 'none' : '';
    conf.panelVisible = !vis;
    saveConf();
}

// ════════════════════════════════════════════════════════════════════════════
// 设置面板（注入扩展设置区）
// ════════════════════════════════════════════════════════════════════════════
async function injectSettings() {
    const ctx = SillyTavern.getContext();
    const $area = jQuery('#extensions_settings2');
    if (!$area.length) return;

    const rows = Object.keys(conf.pricing).map(k => {
        const p = conf.pricing[k];
        return `<tr data-model="${k}">
            <td>${k}</td>
            <td><input class="tc-price text_pole" data-f="input" type="number" step="0.01" value="${p.input}"></td>
            <td><input class="tc-price text_pole" data-f="cacheRead" type="number" step="0.01" value="${p.cacheRead}"></td>
            <td><input class="tc-price text_pole" data-f="output" type="number" step="0.01" value="${p.output}"></td>
        </tr>`;
    }).join('');

    const html = `
    <div class="tc-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>Token 统计 (实时计价)</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
          <label class="checkbox_label"><input id="tc-set-visible" type="checkbox" ${conf.panelVisible ? 'checked' : ''}> 显示浮动面板</label>
          <small>价格单位：人民币 ¥ / 百万 token。匹配规则为「模型名包含关键字」。</small>
          <table class="tc-price-table">
            <thead><tr><th>模型关键字</th><th>输入</th><th>缓存读</th><th>输出</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div class="tc-set-btns">
            <input id="tc-set-show" class="menu_button" type="button" value="显示面板">
            <input id="tc-set-resetcur" class="menu_button" type="button" value="重置本对话">
            <input id="tc-set-resetall" class="menu_button" type="button" value="重置全部">
            <input id="tc-set-resetprice" class="menu_button" type="button" value="恢复默认价">
          </div>
        </div>
      </div>
    </div>`;
    $area.append(html);

    jQuery('#tc-set-visible').on('change', function () {
        conf.panelVisible = this.checked; saveConf();
        const el = document.getElementById(PANEL_ID);
        if (el) el.style.display = this.checked ? '' : 'none';
    });
    jQuery(document).on('change', '.tc-price', function () {
        const model = jQuery(this).closest('tr').data('model');
        const f = jQuery(this).data('f');
        const v = parseFloat(this.value);
        if (conf.pricing[model] && !isNaN(v)) {
            conf.pricing[model][f] = v;
            if (f === 'input') conf.pricing[model].cacheWrite = v; // 简化：缓存写≈输入价
            saveConf();
            renderPanel();
        }
    });
    jQuery('#tc-set-show').on('click', showPanel);
    jQuery('#tc-set-resetcur').on('click', () => {
        allData[curChatId()] = emptyStat(); saveData(); renderPanel();
        toastr?.info?.('已重置本对话统计');
    });
    jQuery('#tc-set-resetall').on('click', () => {
        allData = {}; saveData(); renderPanel();
        toastr?.info?.('已重置全部统计');
    });
    jQuery('#tc-set-resetprice').on('click', () => {
        conf.pricing = structuredClone(DEFAULT_PRICING);
        conf.fallback = structuredClone(FALLBACK_PRICE);
        saveConf();
        jQuery('.tc-settings').remove();
        injectSettings();
        toastr?.info?.('已恢复默认价格');
    });
}

// ════════════════════════════════════════════════════════════════════════════
// Slash 指令（中文）
// ════════════════════════════════════════════════════════════════════════════
function registerCommands() {
    try {
        const ctx = SillyTavern.getContext();
        const { SlashCommandParser, SlashCommand } = ctx;
        if (!SlashCommandParser || !SlashCommand) return;

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'token',
            callback: () => {
                const s = curStat();
                return `本对话累计：输入 ${formatCN(s.totalIn)}｜输出 ${formatCN(s.totalOut)}｜请求 ${s.reqCount} 次｜总费用 ${fmtMoney(s.totalCost, 2)}｜已节省 ${fmtMoney(s.totalSaved, 2)}`;
            },
            returns: '当前对话的 Token 统计摘要',
            helpString: '显示当前对话的 Token 用量与费用统计。',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'token-reset',
            callback: () => {
                allData[curChatId()] = emptyStat();
                saveData(); renderPanel();
                return '已重置本对话的 Token 统计。';
            },
            returns: '重置结果',
            helpString: '重置当前对话的 Token 统计数据。',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'token-panel',
            callback: () => { togglePanel(); return '已切换 Token 面板显隐。'; },
            returns: '切换结果',
            helpString: '显示或隐藏 Token 统计浮动面板。',
        }));
    } catch (e) {
        console.error('[Token统计] 注册指令失败', e);
    }
}

// ════════════════════════════════════════════════════════════════════════════
// 初始化
// ════════════════════════════════════════════════════════════════════════════
function init() {
    const ctx = SillyTavern.getContext();
    const { eventSource, eventTypes } = ctx;

    buildPanel();
    injectSettings();
    registerCommands();

    // 切换对话 → 刷新面板为该对话数据
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        allData = loadAllData();          // 重新读取，避免多标签页不同步
        renderPanel();
    });

    console.log('[Token统计] 扩展已加载');
}

jQuery(async () => {
    // 等待 getContext 就绪
    if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) {
        const t = setInterval(() => {
            if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
                clearInterval(t); init();
            }
        }, 300);
    } else {
        init();
    }
});
