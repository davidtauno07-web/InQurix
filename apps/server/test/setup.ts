// Tests wipe their database, so they only ever run against TEST_DATABASE_URL.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL (a separate, disposable database) to run server tests');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';
process.env.APP_URL = 'http://localhost:4100';
process.env.INQURIX_DISABLE_RATE_LIMIT = '1';
process.env.SECRET_KEY ||= 'test-secret-key-test-secret-key-test-secret-key';
process.env.PADDLE_WEBHOOK_SECRET = 'pdl_ntfset_test_secret';
process.env.PADDLE_PRICE_PRO_MONTHLY = 'pri_pro_test';
process.env.PADDLE_PRICE_BUSINESS_MONTHLY = 'pri_business_test';
process.env.PADDLE_API_KEY = '';
process.env.SMTP_URL = '';
