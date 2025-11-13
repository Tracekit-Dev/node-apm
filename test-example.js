const express = require('express');
const { init, middleware, getClient } = require('./dist/index.js');

const app = express();

// Initialize TraceKit with code monitoring enabled
const client = init({
  apiKey: 'test-api-key',
  endpoint: 'http://localhost:8081/v1/traces',
  serviceName: 'node-test-app',
  enableCodeMonitoring: true,  // Enable code monitoring
});

// Use the middleware (includes request context extraction)
app.use(middleware());

// Test route with automatic snapshot capture
app.get('/test', (req, res) => {
  // This will automatically capture a snapshot if breakpoint is active
  client.captureSnapshot('test-route', {
    userId: '123',
    action: 'test-request',
    timestamp: new Date().toISOString(),
  });

  res.json({
    message: 'Test route executed',
    timestamp: new Date().toISOString(),
  });
});

// Another test route with different label
app.post('/order', (req, res) => {
  // Process order logic
  const orderId = 'order_' + Date.now();

  // This will auto-create a breakpoint and capture snapshot if active
  client.captureSnapshot('order-processing', {
    orderId,
    amount: 99.99,
    items: ['item1', 'item2'],
  });

  res.json({
    orderId,
    status: 'processed',
  });
});

// Error route to test exception capture
app.get('/error', (req, res) => {
  try {
    // This will capture a snapshot on error
    client.captureSnapshot('error-test', {
      step: 'before-error',
    });

    // Simulate an error
    throw new Error('Test error for code monitoring');
  } catch (error) {
    client.captureSnapshot('error-caught', {
      error: error.message,
      step: 'after-error',
    });

    res.status(500).json({
      error: error.message,
      captured: true,
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'node-test-app',
    codeMonitoringEnabled: !!client.getSnapshotClient(),
  });
});

const port = process.argv[2] || 3000;

app.listen(port, () => {
  console.log(`🚀 Node.js test app running on port ${port}`);
  console.log(`📸 Code monitoring enabled: ${!!client.getSnapshotClient()}`);
  console.log('');
  console.log('Test endpoints:');
  console.log(`  GET  http://localhost:${port}/health`);
  console.log(`  GET  http://localhost:${port}/test`);
  console.log(`  POST http://localhost:${port}/order`);
  console.log(`  GET  http://localhost:${port}/error`);
});
