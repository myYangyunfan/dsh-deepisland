'use strict';
/**
 * 快照协议 v2 —— 主进程 → 渲染进程的唯一数据形状（纯函数，不依赖 electron）。
 *
 * 拆成独立模块的原因不是「代码整洁」，而是**这个文件是纯的、可以用 node 直接
 * 断言**。协议里的两条性能纪律（DTO 体积、rev 去重）一旦回归，在真机上只表现
 * 为「CPU 悄悄变高、岛偶尔不刷新」，不会报任何错 —— 只能靠测试钉住。
 *
 * ## 为什么必须是一份 DTO（而不是把 monitor 的内部对象直接发过去）
 *
 * 旧快照是 `{ now, entries: monitor.poll(), config: {...}, bridge, jump }`，
 * 其中每个 entry 还挂着：
 * - `activity`（会话状态机内部对象，里面又挂着 `proj` = DSH 投影原样解析结果，
 *   20+ 字段、含 `pendingCallIds` 数组与标题字符串）；
 * - `file`（本机绝对路径）、`project`（磁盘目录名）、`mtimeMs`。
 *
 * 三个后果，都是真实存在的反例：
 * 1. **rev 去重直接失效**：`now` 每拍都变、`mtimeMs` 在 DSH 干活时每拍都变，
 *    整包 JSON 必然不同 → 仍然 250ms 推一次，与「只在真变化时推送」相反；
 * 2. **每拍跨进程复制几十 KB**，渲染层却只读其中十几个短字符串；
 * 3. **把本机绝对路径和投影全量塞进渲染进程**，而渲染层根本不读文件，
 *    只是多开了一个信息面。
 *
 * 所以这里**白名单式**地只映射渲染层真会消费的字段，其余一律不出现。
 * 契约 §4 里「payload 禁止包含 now/activity/proj/file/mtimeMs/project」
 * 指的就是这件事，不是风格偏好。
 *
 * @module snapshot
 */

/** 协议版本。字段语义变化时 +1，旧 renderer 可据此降级。 */
const SNAPSHOT_VERSION = 2;

/** 有活跃会话时的轮询间隔（与 Swift 版一致：「跟手」与「不烧 CPU」的交点）。 */
const ACTIVE_TICK_MS = 250;

/**
 * 全空闲 / 窗口隐藏时的轮询间隔。
 *
 * 空闲时 DSH 不会写会话文件，250ms 只是白扫；隐藏时更没有任何东西可显示
 * （隐藏窗口是用户主动收起，不是等动画）。契约 §7 要求「不新增常驻高频定时器」，
 * 降到 1s 后实际 I/O 次数降到 1/4。
 */
const IDLE_TICK_MS = 1000;

/**
 * 会进入 DTO 的 entry 字段（也定义顺序；顺序只影响发送字节，不影响 rev，
 * 因为 rev 用的是**排序后**的稳定序列化）。
 *
 * 含 `elapsedText` 是为了兼容旧 renderer / shots.js：契约 §4 允许保留它，
 * 新 renderer 优先用 `elapsedFrom` 自己按秒走字 —— 后者才是「不闪、不卡」的
 * 正解：旧字段是「主进程按拍算好的字符串」，1s 一跳，和本地时钟必然差半拍。
 */
const ENTRY_FIELDS = [
  'id', 'label', 'shortId',
  'status', 'live',
  'glow', 'tag', 'badge',
  'elapsedFrom', 'elapsedText',
  'turnStepText', 'toolCountText', 'outputText',
  'contextText', 'contextFraction', 'contextLevel',
  'todoText', 'todoDone', 'todoTotal', 'todoCurrent',
  'subagentText', 'pendingTools',
  'detailText', 'actionText',
];

/**
 * 恒有字段：标识与状态。其余字段**值为空（null / '' / 0）时直接从 DTO 里省略**。
 *
 * 这是体积达标（≤ 基线 40%）的必要一步，不是顺手优化：
 * - 空闲会话的 `elapsedFrom/todoDone/todoTotal/pendingTools/contextFraction`
 *   全是空值，六个会话 × 七八个键 = 好几百字节，而渲染层读到的语义完全一样
 *   （`e.todoTotal || 0`）。空值带键只是把「JSON 里的 null」当默认值传。
 * - 代价是契约 §4 的字段在缺省时**不存在**。渲染层必须按「缺省 = 空/0」读，
 *   不能写 `e.todoDone.toFixed()`。这条约定写在契约的字段说明里比藏在代码里好，
 *   所以这里显式列出来。
 *
 * 反例：早先把所有键一律带上（含 null），DTO 稳定落在旧快照的 41%，正好超过
 * 契约的 40% 线；而线上限缩掉的只是空值，没有丢任何一个「有内容」的字段。
 */
const ENTRY_ALWAYS = ['id', 'label', 'shortId', 'status', 'live', 'glow', 'tag', 'badge'];

/** 非字符串原样（null）透传；数字转成字符串（投影里的 token 数可能是数字）。 */
function text(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** 有限数字才收，其它（NaN / Infinity / undefined）统一成 null。 */
function num(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
}

/** 非负整数，缺省 0。 */
function count(v) {
  return (typeof v === 'number' && Number.isFinite(v) && v > 0) ? Math.trunc(v) : 0;
}

/**
 * 是「空值」—— 这类字段不进 DTO（见 ENTRY_ALWAYS 的注释）。
 * 0 也算空：`pendingTools: 0` / `todoTotal: 0` / `contextLevel: 0` 的语义
 * 就是「这一项不显示」，带键只会让每个会话多十几个字节。
 */
function isBlank(v) {
  return v === null || v === undefined || v === '' || v === 0;
}

/**
 * 把一个 monitor 内部 entry 映射成 DTO。
 *
 * 取值全部走 display 字段（monitor.decorate 已经算好的文本），**不在这里
 * 重新计算**：算两遍必然会在两处口径分叉，而这里没有数据上下文。
 *
 * @param {object} entry monitor.poll() 产出的内部 entry
 * @returns {object} 稳定形状的 DTO entry：恒有字段见 ENTRY_ALWAYS，
 *                   其余字段「有值才出现」（缺省语义由渲染层按 0/null 处理）
 */
function mapEntry(entry) {
  const e = (entry && typeof entry === 'object') ? entry : {};
  const status = (typeof e.status === 'string' && e.status) ? e.status : 'idle';
  const dto = {
    id: text(e.id),
    label: text(e.label),
    shortId: text(e.shortId),
    status,
    // live 由 status 派生，而不是信 monitor 里的 isActive() 调用点：
    // DTO 只认契约口径（status !== 'idle'），两处各算一次就会不同步。
    live: status !== 'idle',
    glow: text(e.glow),
    tag: text(e.tag),
    badge: text(e.badge),
    elapsedFrom: (num(e.elapsedFrom) > 0) ? num(e.elapsedFrom) : null,
    elapsedText: text(e.elapsedText),
    turnStepText: text(e.turnStepText),
    toolCountText: text(e.toolCountText),
    outputText: text(e.outputText),
    contextText: text(e.contextText),
    contextFraction: (() => {
      const f = num(e.contextFraction);
      return (f === null) ? null : Math.min(1, Math.max(0, f));
    })(),
    contextLevel: count(e.contextLevel),
    todoText: text(e.todoText),
    todoDone: count(e.todoDone),
    todoTotal: count(e.todoTotal),
    todoCurrent: text(e.todoCurrent),
    subagentText: text(e.subagentText),
    pendingTools: count(e.pendingTools),
    detailText: text(e.detailText),
    actionText: text(e.actionText),
  };
  for (const k of Object.keys(dto)) {
    // 白名单守门：以后 mapEntry 里手滑多塞一个字段（比如又想带上 file），
    // 会在 rev/体积断言之前先被这里拦掉。
    if (!ENTRY_FIELDS.includes(k)) { delete dto[k]; continue; }
    // 恒有字段永远保留；其余空值省略（见 ENTRY_ALWAYS 注释）。
    if (!ENTRY_ALWAYS.includes(k) && isBlank(dto[k])) delete dto[k];
  }
  return dto;
}

/**
 * config.load() 的结果 → 契约 §4 的 config DTO。
 *
 * 旧快照发的是 `{ notchEnabled, jumpEnabled, idleHide, scale, fileExists, raw }`，
 * 其中 `raw` 是用户配置原文件（含白名单外的历史键）。渲染层真正要的只有下面
 * 6 项，其余是体积和「第二个真相源」。
 *
 * `glowEffect` / `expandOnHover` 不在 config.load() 的顶层字段里 —— 它们只存在
 * 于 raw（插件设置面板写的就是 raw），默认值必须是 true 才与旧 renderer 的
 * 判定等价（旧代码是 `raw.x === false ? false : true`）。
 *
 * @param {object} cfg config.load() 的返回值
 */
function configDto(cfg) {
  const c = (cfg && typeof cfg === 'object') ? cfg : {};
  const raw = (c.raw && typeof c.raw === 'object') ? c.raw : {};
  const bool = (v, dflt) => (typeof v === 'boolean' ? v : dflt);
  return {
    scale: (typeof c.scale === 'number' && Number.isFinite(c.scale) && c.scale >= 0.5 && c.scale <= 2)
      ? c.scale : 1,
    glowEffect: bool(raw.glowEffect, true),
    expandOnHover: bool(raw.expandOnHover, true),
    notchEnabled: bool(c.notchEnabled, true),
    idleHide: bool(c.idleHide, true),
    jumpEnabled: bool(c.jumpEnabled, true),
  };
}

/** bridge.health() 的结果 → 契约 §4 的 `{ ok, port, pending }`。 */
function bridgeDto(b) {
  const o = (b && typeof b === 'object') ? b : {};
  return {
    ok: o.ok === true,
    port: (typeof o.port === 'number' && Number.isFinite(o.port)) ? o.port : 47311,
    pending: count(o.pending),
  };
}

/** 跳转回执：`{ kind, brief, at }`，没有就是 null。 */
function jumpDto(j) {
  if (!j || typeof j !== 'object') return null;
  const kind = text(j.kind);
  const brief = text(j.brief);
  const at = num(j.at);
  if (!kind || !brief || at === null) return null;
  return { kind, brief, at };
}

/**
 * 稳定序列化：对象键排序、数组保序。
 *
 * rev 必须只由**内容**决定，不能由构造顺序决定：同一份内容从不同代码路径
 * 拼出来（比如一个字段先写后补、或者以后在中间插了一个键）不应该产生新 rev，
 * 否则「内容没变也推」会悄悄回来。JSON.stringify 保留插入顺序，不能直接用。
 *
 * @param {any} value
 * @returns {string}
 */
function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value);
    return s === undefined ? 'null' : s;
  }
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/** FNV-1a 32 位。用两轮不同种子拼成 ~64 位的有效空间，见 shortRev 的注释。 */
function fnv1a32(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 内容 → 短 rev。
 *
 * 32 位单哈希在「每 250ms 一次、跑一整天」的量级下碰撞是可能的（生日问题），
 * 而一次碰撞 = 界面停在旧数据上不动，很难复现。所以取两个不同种子的 32 位
 * 哈希拼起来（有效空间 64 位），用 base36 压到 13 个字符左右 —— 快照里只占
 * 十几个字节，随 payload 每跳走。
 *
 * **不是**安全哈希：它的用途只是「相等性」而不是防篡改；内容由主进程自己产生，
 * 渲染层不做鉴权。别拿它当校验和用。
 *
 * @param {string} content stableStringify 后的内容
 * @returns {string}
 */
function shortRev(content) {
  const a = fnv1a32(content, 0x811c9dc5);
  const b = fnv1a32(content, 0x9e3779b9);
  return a.toString(36).padStart(7, '0') + b.toString(36).padStart(7, '0');
}

/**
 * 从 payload 计算 rev：**排除 serverNow**。
 *
 * serverNow 是「主进程此刻的钟」，每次发送都不同；它参与 rev 的话每一拍都会
 * 判成「变了」，去重就白做了。渲染层仍需要它：本地时钟和主进程可能差几秒，
 * 用 serverNow 校正 elapsedFrom 的走字才不会从 00:03 起跳。
 *
 * @param {object} payload 不含 rev，或含旧 rev 都可（下划线开头/rev 字段被剔除）
 */
function revOf(payload) {
  const p = (payload && typeof payload === 'object') ? payload : {};
  const body = {};
  for (const k of Object.keys(p)) {
    if (k === 'rev' || k === 'serverNow') continue;
    body[k] = p[k];
  }
  return shortRev(stableStringify(body));
}

/**
 * 组装一份可发送的快照。
 *
 * 顺序：先映射 content → 算 rev → 最后挂 serverNow。rev 因此天然不含
 * serverNow（也见上文为什么）。
 *
 * @param {{ entries?: Array<object>, config?: object, bridge?: object,
 *           jump?: object|null, now?: number }} input
 *   entries 是 monitor.poll() 的内部 entry 数组；config 是 config.load() 的结果。
 * @returns {{ v: number, rev: string, entries: object[], config: object,
 *             bridge: object, jump: object|null, serverNow: number }}
 */
function buildSnapshot(input) {
  const i = (input && typeof input === 'object') ? input : {};
  const now = (typeof i.now === 'number' && Number.isFinite(i.now)) ? i.now : Date.now();
  const entries = Array.isArray(i.entries) ? i.entries.map(mapEntry) : [];
  const content = {
    v: SNAPSHOT_VERSION,
    entries,
    config: configDto(i.config),
    bridge: bridgeDto(i.bridge),
    jump: jumpDto(i.jump),
  };
  return {
    v: content.v,
    rev: revOf(content),
    entries: content.entries,
    config: content.config,
    bridge: content.bridge,
    jump: content.jump,
    serverNow: now,
  };
}

/**
 * 下一拍该等多久（契约 §7 的自适应轮询）。
 *
 * 三档语义：
 * - **窗口隐藏**：没有任何东西可见，一律 1000ms。隐藏可能是用户主动收起，
 *   也可能被 idleHide 自动收起；两种都不需要跟手。
 * - **有活跃会话**（`live === true`，含 done 回执期）：250ms。
 *   这里**不**看 `status` 字符串，避免和 DTO 的 live 口径分叉。
 * - **全空闲**：1000ms。空闲时 DSH 不写会话文件，250ms 纯属白扫 ——
 *   这是「空闲 CPU 显著下降」这条验收指标的主要来源。
 *
 * 反例记录：早期按固定 250ms 跑，即使岛已经自动藏起来也在扫盘，任务管理器里
 * 常驻 1%~3% 的 CPU 基本全花在这里。
 *
 * @param {Array<object>|null|undefined} entries DTO entries（也容错接受 monitor 内部 entry）
 * @param {boolean} hidden 窗口当前是否隐藏/不可见
 * @returns {number} 毫秒
 */
function nextDelay(entries, hidden) {
  if (hidden) return IDLE_TICK_MS;
  const list = Array.isArray(entries) ? entries : [];
  for (const e of list) {
    if (!e) continue;
    const live = (typeof e.live === 'boolean')
      ? e.live
      : (typeof e.status === 'string' && e.status !== 'idle');
    if (live) return ACTIVE_TICK_MS;
  }
  return IDLE_TICK_MS;
}

module.exports = {
  SNAPSHOT_VERSION,
  ACTIVE_TICK_MS,
  IDLE_TICK_MS,
  ENTRY_FIELDS,
  mapEntry,
  configDto,
  bridgeDto,
  jumpDto,
  stableStringify,
  shortRev,
  revOf,
  buildSnapshot,
  nextDelay,
};
