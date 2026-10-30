// D-197 (client 30-10): a stock item's sub code = its account's code × 10 + n (n = 1 … 99) — always 6 digits: 13110 → 131101 … 131109,
// 131110 …; 13600's tenth item = 136010, not 1360010. D-165's form (account + 2 digits: 1311001) is still read, so `item-codes-6`, the
// account recode (D-178) and the next free code understand items not re-coded yet. No imports: catalog, accounting and the CLI share it.
export const subCode = (account: string, n: number): string => String(Number(account) * 10 + n);
/** n of a 6-digit sub code under this account, else 0 */
export const subN = (account: string, code: string): number => {
  if (!/^\d{6}$/.test(code)) return 0;
  const n = Number(code) - Number(account) * 10;
  return n >= 1 && n <= 99 ? n : 0;
};
/** n of a D-165 code (account + 2 digits), else 0 */
export const legacyN = (account: string, code: string): number =>
  code.length === account.length + 2 && code.startsWith(account) && /^\d{2}$/.test(code.slice(account.length)) ? Number(code.slice(account.length)) : 0;
