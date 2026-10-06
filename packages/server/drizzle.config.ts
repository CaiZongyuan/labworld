import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/{core,lab}/**/schema.ts',
  out: './migrations',
});
