/**
 * Currency formatting — the wallet is denominated in Indian rupees.
 *
 * Everything that renders an amount goes through here so the symbol and the
 * grouping stay consistent. `en-IN` grouping is lakh/crore style
 * (₹1,25,000.00), not the western ₹125,000.00.
 */

export const CURRENCY_SYMBOL = '₹';
export const CURRENCY_CODE = 'INR';
export const CURRENCY_LOCALE = 'en-IN';

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** ₹1,25,000.00 — for ledger amounts and balances. */
export function money(value) {
  return CURRENCY_SYMBOL + toNumber(value).toLocaleString(CURRENCY_LOCALE, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** ₹1,25,000 — for round figures like the daily limit or preset labels. */
export function moneyShort(value) {
  return CURRENCY_SYMBOL + toNumber(value).toLocaleString(CURRENCY_LOCALE, {
    maximumFractionDigits: 0,
  });
}
