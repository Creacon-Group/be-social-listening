import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Env } from '../../config/env.js';

/** SMTP sender. Credentials come from SMTP_* in the environment. */
@Injectable()
export class MailService {
  private transporter?: Transporter;
  private readonly from?: string;

  constructor(private readonly config: ConfigService<Env, true>) {
    this.from =
      config.get('MAIL_FROM', { infer: true }) ??
      config.get('SMTP_USER', { infer: true });
  }

  get configured() {
    return Boolean(this.config.get('SMTP_HOST', { infer: true }) && this.from);
  }

  private transport() {
    if (!this.configured)
      throw new ServiceUnavailableException(
        'Email belum dikonfigurasi di server (SMTP_HOST, SMTP_USER, SMTP_PASS, MAIL_FROM).',
      );
    const port = this.config.get('SMTP_PORT', { infer: true });
    this.transporter ??= nodemailer.createTransport({
      host: this.config.get('SMTP_HOST', { infer: true }),
      port,
      secure: this.config.get('SMTP_SECURE', { infer: true }) ?? port === 465,
      auth: this.config.get('SMTP_USER', { infer: true })
        ? {
            user: this.config.get('SMTP_USER', { infer: true }),
            pass: this.config.get('SMTP_PASS', { infer: true }),
          }
        : undefined,
    });
    return this.transporter;
  }

  async send(msg: {
    to: string[];
    subject: string;
    html: string;
    text: string;
    attachments: {
      filename: string;
      content: Buffer;
      cid?: string;
      contentType?: string;
    }[];
  }) {
    const info = await this.transport().sendMail({ from: this.from, ...msg });
    return { messageId: info.messageId, accepted: info.accepted };
  }
}
