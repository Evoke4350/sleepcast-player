/** Field checks for values read back from storage, shared by the shape
 *  checks (isNight, isLiveSession) so both apply one rule. A number is a
 *  finite one: NaN or Infinity would turn every sum it enters into nonsense. */
export const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export const numOrNull = (v: unknown): boolean => v === null || num(v);
export const optNum = (v: unknown): boolean => v === undefined || num(v);
export const optBool = (v: unknown): boolean => v === undefined || typeof v === "boolean";
export const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const arrayOrAbsent = (v: unknown): boolean => v === undefined || Array.isArray(v);
