/**
 * @module @dsh-external/dsh-vibe-island
 * DeepSeek Harness 智能体刘海灵动岛 - 服务端 Cordis 插件
 * 
 * 职责：
 * 1. 在 DSH settings 注册 `dsh-vibe-island` 命名空间，提供灵动岛形态配置（开关、位置、平台模式、动效）。
 * 2. 供客户端 (lib/client.js) 经 settingsScope.bind 读取热配置。
 * 3. 容错回退设计：settings 注册失败仅告警，不阻断宿主启动。
 */
import z from '@deepseek-ai/schemastery';

export const name = '@dsh-external/dsh-vibe-island';
export const inject = ['settings'];

export const Config = z.object({
  enabled: z.boolean().default(true)
    .description('灵动岛主开关：开启后在屏幕或窗口顶部居中显示智能体状态灵动岛'),
  placement: z.union([
    z.const('notch').description('Mac刘海/顶部吸附（紧贴屏幕物理或窗口顶端）'),
    z.const('floating').description('居中浮动药丸（微距向下偏移 10px，全圆角）'),
    z.const('top-right').description('右上角紧凑浮标（不遮挡主内容）'),
  ]).default('notch')
    .description('灵动岛放置位置与形态'),
  platformMode: z.union([
    z.const('auto').description('自动嗅探（根据当前操作系统自适应刘海或 Fluent 风格）'),
    z.const('macos').description('强制 macOS 风格（黑晶微倒角，紧凑贴合）'),
    z.const('windows').description('强制 Windows 11 风格（Fluent 亚克力毛玻璃圆角药丸）'),
  ]).default('auto')
    .description('平台视觉拟态风格'),
  glowEffect: z.boolean().default(true)
    .description('流动光晕与呼吸脉冲动效（Thinking 蓝紫光、Tool 执行高亮）'),
  expandOnHover: z.boolean().default(true)
    .description('鼠标悬停时自动展开 HUD 卡片（显示详细命令、Token 与耗时）'),
  showSubagentCount: z.boolean().default(true)
    .description('当存在并行子代理（Subagent）时在岛体右侧显示微章计数'),
  scale: z.number().step(0.05).min(0.8).max(1.3).default(1.0)
    .description('灵动岛整体缩放比例 (0.8 ~ 1.3)'),
});

const NS = 'dsh-vibe-island';

export function apply(ctx, config) {
  try {
    if (ctx.settings && typeof ctx.settings.register === 'function') {
      ctx.settings.register(NS, Config, { base: config || {} });
    }
  } catch (error) {
    console.warn('[dsh-vibe-island] settings registration fallback: ' + ((error && error.message) || error));
  }
}
