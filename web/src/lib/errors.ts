import type { StructuredApiErrorBody } from "../domain";

export class StructuredApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly nextAction?: string;
  readonly requestId?: string;
  readonly status: number;

  constructor(body: StructuredApiErrorBody, status = 500) {
    super(body.message);
    this.name = "StructuredApiError";
    this.code = body.code;
    this.retryable = body.retryable ?? false;
    this.nextAction = body.nextAction;
    this.requestId = body.requestId;
    this.status = status;
  }
}

export function userFacingError(error: unknown): string {
  if (error instanceof StructuredApiError) {
    return `${error.message}${error.nextAction ? ` ${error.nextAction}` : ""}`;
  }
  if (error instanceof DOMException && error.name === "AbortError") return "Request cancelled.";
  if (error instanceof Error) return error.message;
  return "The request could not be completed.";
}
