// tests/setup.ts — vitest setupFiles：worker 啟動先清會干擾 suite 的 ambient env。
//
// shell 環境若帶著這些變數跑測試，config / scope-policy 的啟動期決策會走到
// 非測試預期分支（forced-mode、fail-fast throw、legacy fallback），整個 suite 炸掉。
// 個別測試需要這些 env 時自行 setEnv + vi.resetModules()（見 tests/config.test.ts 模式）。
delete process.env.CC_FORCE_PROJECT_ID;
delete process.env.DATABASE_URL_PERSONAL;
delete process.env.CC_MEMORY_PROJECT_ID;
