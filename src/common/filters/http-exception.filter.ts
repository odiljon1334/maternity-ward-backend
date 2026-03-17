import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const message =
      exception instanceof HttpException
        ? exception.getResponse()
        : 'Ichki server xatosi';

    // 401/403/400 uchun faqat qisqa log, stack trace yo'q
    if (status >= 500) {
      this.logger.error(`${request.method} ${request.url} - ${status}`, exception instanceof Error ? exception.stack : '');
    } else {
      const msg = typeof message === 'object' ? (message as any).message : message;
      this.logger.warn(`${request.method} ${request.url} - ${status} ${Array.isArray(msg) ? msg[0] : msg}`);
    }

    response.status(status).json({
      success: false,
      statusCode: status,
      message: typeof message === 'object' ? (message as any).message : message,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
