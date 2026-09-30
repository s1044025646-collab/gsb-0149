/**
 * Typed application errors with stable machine-readable codes.
 * The HTTP layer maps these codes to status codes; the CLI prints them verbatim.
 */
export type ErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "MD_NOT_STRICTLY_INCREASING"
  | "INVALID_ANGLE"
  | "NEAR_OPPOSITE_TANGENT"
  | "NORTH_REF_MISMATCH"
  | "UNIT_MISMATCH"
  | "OUT_OF_RANGE"
  | "BAD_REQUEST"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

export function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
    case "MD_NOT_STRICTLY_INCREASING":
    case "NORTH_REF_MISMATCH":
      return 409;
    case "VALIDATION":
    case "INVALID_ANGLE":
    case "NEAR_OPPOSITE_TANGENT":
    case "UNIT_MISMATCH":
    case "OUT_OF_RANGE":
    case "BAD_REQUEST":
      return 400;
    default:
      return 500;
  }
}
