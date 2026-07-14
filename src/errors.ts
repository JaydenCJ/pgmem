/** Error type thrown for all pgmem usage and state errors. */
export class PgMemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PgMemError";
  }
}
