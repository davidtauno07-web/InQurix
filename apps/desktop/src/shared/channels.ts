export const INVOKE_CHANNELS = [
  'search', 'doc:get', 'doc:open', 'doc:reveal', 'doc:related',
  'sources:list', 'sources:add', 'sources:remove', 'sources:update', 'sources:rescan', 'exclusions:set',
  'index:status', 'index:pause', 'index:resume', 'index:failures', 'index:events',
  'settings:get', 'settings:update',
  'history:list', 'history:clear', 'saved:list', 'saved:add', 'saved:remove', 'pins:list', 'pins:toggle', 'recent:list',
  'quick:hide', 'workspace:open', 'app:info',
] as const;
export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];
export const EVENT_CHANNELS = ['index:progress', 'index:state', 'index:changed', 'nav', 'quick:shown', 'shortcut:error'] as const;
export type EventChannel = (typeof EVENT_CHANNELS)[number];
