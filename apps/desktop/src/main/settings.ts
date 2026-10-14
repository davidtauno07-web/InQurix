import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const SettingsSchema = z.object({
  shortcut: z.string().default(process.platform === 'darwin' ? 'Command+Shift+Space' : 'Control+Shift+Space'),
  launchAtLogin: z.boolean().default(false),
  ocr: z.boolean().default(true),
  semantic: z.boolean().default(true),
  reconcileMinutes: z.number().int().min(5).max(1440).default(30),
  onboarded: z.boolean().default(false),
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  keepHistory: z.boolean().default(true),
  reminders: z.boolean().default(true),
});
export type Settings = z.infer<typeof SettingsSchema>;

export class SettingsStore {
  private value: Settings;
  constructor(private file: string) {
    let raw: unknown = {};
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run or corrupt: defaults */ }
    const parsed = SettingsSchema.safeParse(raw);
    this.value = parsed.success ? parsed.data : SettingsSchema.parse({});
  }
  get(): Settings { return { ...this.value }; }
  update(patch: Partial<Settings>): Settings {
    this.value = SettingsSchema.parse({ ...this.value, ...patch });
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return this.get();
  }
}
