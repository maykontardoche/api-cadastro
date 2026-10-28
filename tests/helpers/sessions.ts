import request from 'supertest';
import type { Express } from 'express';

import type { PrismaClient } from '../../src/generated/prisma/client.js';
import type { PublicUser } from '../../src/modules/users/user.schema.js';

export interface SessionData {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  refreshToken: string;
  user: PublicUser;
}

export const ANA = {
  name: 'Ana Souza',
  email: 'ana@example.com',
  password: 'correct horse battery staple',
};

export async function registerAndLogin(app: Express, person = ANA): Promise<SessionData> {
  await request(app).post('/api/v1/auth/register').send(person);
  const response = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: person.email, password: person.password });
  return (response.body as { data: SessionData }).data;
}

export async function loginAgain(app: Express, person = ANA): Promise<SessionData> {
  const response = await request(app)
    .post('/api/v1/auth/login')
    .send({ email: person.email, password: person.password });
  return (response.body as { data: SessionData }).data;
}

export function refresh(app: Express, refreshToken: string) {
  return request(app).post('/api/v1/auth/refresh').send({ refreshToken });
}

export function logout(app: Express, refreshToken: string) {
  return request(app).post('/api/v1/auth/logout').send({ refreshToken });
}

export const ADMIN = {
  name: 'Admin Root',
  email: 'admin@example.com',
  password: 'the admin long passphrase',
};

/** Registers through the API, then promotes in the database (the role is re-read per request). */
export async function loginAsAdmin(app: Express, prisma: PrismaClient): Promise<SessionData> {
  const session = await registerAndLogin(app, ADMIN);
  await prisma.user.update({ where: { email: ADMIN.email }, data: { role: 'ADMIN' } });
  return session;
}
