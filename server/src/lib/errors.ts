export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST', details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Inicia sesión para continuar') => new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'No tienes permiso para esta acción') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (what = 'Recurso') => new AppError(404, 'NOT_FOUND', `${what} no encontrado`);
export const conflict = (message: string, code = 'CONFLICT') => new AppError(409, code, message);
