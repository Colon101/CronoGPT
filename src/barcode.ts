const SUPPORTED_BARCODE_LENGTHS = new Set([8, 12, 13, 14]);

export interface BarcodeValidation {
  requested?: string;
  normalized?: string;
  valid: boolean;
  format?: "UPC-E/EAN-8" | "UPC-A" | "EAN-13" | "GTIN-14";
  checkDigitValid?: boolean;
  warning?: string;
}

/**
 * Normalizes the UPC/EAN/GTIN formats accepted by Cronometer's barcode field.
 * Spaces and hyphens are presentation-only; leading zeroes are preserved.
 */
export function validateBarcode(value?: string): BarcodeValidation {
  if (value === undefined) return { requested: undefined, valid: true };

  const requested = value.trim();
  const normalized = requested.replace(/[\s-]+/g, "");
  if (!normalized) {
    return {
      requested,
      normalized,
      valid: false,
      warning: "Barcode cannot be empty.",
    };
  }
  if (!/^\d+$/.test(normalized)) {
    return {
      requested,
      normalized,
      valid: false,
      warning: "Barcode must contain only digits (spaces and hyphens are allowed as separators).",
    };
  }
  if (!SUPPORTED_BARCODE_LENGTHS.has(normalized.length)) {
    return {
      requested,
      normalized,
      valid: false,
      warning: "Barcode must be an 8-digit UPC-E/EAN-8, 12-digit UPC-A, 13-digit EAN-13, or 14-digit GTIN-14 value.",
    };
  }

  const format = normalized.length === 8
    ? "UPC-E/EAN-8"
    : normalized.length === 12
      ? "UPC-A"
      : normalized.length === 13
        ? "EAN-13"
        : "GTIN-14";
  const checkDigitValid = normalized.length === 8
    ? isValidGtinCheckDigit(normalized) || isValidUpcE(normalized)
    : isValidGtinCheckDigit(normalized);
  return {
    requested,
    normalized,
    valid: checkDigitValid,
    format,
    checkDigitValid,
    warning: checkDigitValid ? undefined : `${format} check digit is invalid. Re-scan or re-check the printed barcode before writing it to Cronometer.`,
  };
}

export function isValidGtinCheckDigit(value: string) {
  if (!/^\d{8}$|^\d{12,14}$/.test(value)) return false;
  const data = value.slice(0, -1);
  const expected = gtinCheckDigit(data);
  return Number(value.at(-1)) === expected;
}

export function gtinCheckDigit(data: string) {
  if (!/^\d+$/.test(data)) throw new Error("GTIN data must contain only digits.");
  let sum = 0;
  for (let index = data.length - 1, position = 0; index >= 0; index -= 1, position += 1) {
    const digit = Number(data[index]);
    sum += digit * (position % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

function isValidUpcE(value: string) {
  if (!/^[01]\d{7}$/.test(value)) return false;
  const numberSystem = value[0];
  const [d1, d2, d3, d4, d5, d6] = value.slice(1, 7);
  const checkDigit = value[7];
  let upcAData: string;
  if (/[012]/.test(d6)) {
    upcAData = `${numberSystem}${d1}${d2}${d6}00` + `00${d3}${d4}${d5}`;
  } else if (d6 === "3") {
    upcAData = `${numberSystem}${d1}${d2}${d3}00` + `000${d4}${d5}`;
  } else if (d6 === "4") {
    upcAData = `${numberSystem}${d1}${d2}${d3}${d4}0` + `0000${d5}`;
  } else {
    upcAData = `${numberSystem}${d1}${d2}${d3}${d4}${d5}` + `0000${d6}`;
  }
  return Number(checkDigit) === gtinCheckDigit(upcAData);
}
