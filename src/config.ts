// src/config.ts
import 'dotenv/config';

export const config = {
  databaseUrl: process.env.DATABASE_URL!,
  nodeEnv: process.env.NODE_ENV || 'development',
};

if (!config.databaseUrl) {
  throw new Error('DATABASE_URL is required');
}
