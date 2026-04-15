/** Extract a human-readable message from any thrown value. */
export function getErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    return 'Erro desconhecido';
}
