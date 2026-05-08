const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const lambda = new LambdaClient({ region: 'us-east-1' });

const functions = ['process-orders', 'send-notifications', 'api-handler'];

async function invoke(name) {
  try {
    await lambda.send(new InvokeCommand({
      FunctionName: name,
      Payload: Buffer.from(JSON.stringify({ test: true }))
    }));
    console.log(`✅ Invoked ${name}`);
  } catch (e) {
    console.log(`❌ ${name}: ${e.message}`);
  }
}

async function run() {
  console.log('🚀 Load test running — watch your dashboard at http://localhost:3001\n');
  let count = 0;
  setInterval(async () => {
    count++;
    console.log(`\n--- Round ${count} ---`);
    for (const fn of functions) await invoke(fn);
  }, 10000);
  
  // Run first round immediately
  for (const fn of functions) await invoke(fn);
}

run();