const DAY = 86_400_000;
const ms = (iso: string) => Date.parse(iso.slice(0, 10) + 'T00:00:00Z');

export const addDays = (iso: string, days: number) => new Date(ms(iso) + days * DAY).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => Math.round((ms(to) - ms(from)) / DAY);
