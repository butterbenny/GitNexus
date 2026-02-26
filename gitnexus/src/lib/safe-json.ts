export const safeStringify = (value: unknown, space?: number | string): string => {
  return JSON.stringify(
    value,
    (_key, v) => (typeof v === 'bigint' ? v.toString() : v),
    space,
  );
};
