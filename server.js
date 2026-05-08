/**
 * ServerlessOps Backend — Express + AWS SDK
 * Run: npm install && node server.js
 * Env vars: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION
 */

const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const {
  CloudWatchClient,
  GetMetricDataCommand,
  GetMetricStatisticsCommand,
} = require("@aws-sdk/client-cloudwatch");
const {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  DescribeLogGroupsCommand,
} = require("@aws-sdk/client-cloudwatch-logs");
const {
  LambdaClient,
  ListFunctionsCommand,
  GetFunctionConcurrencyCommand,
} = require("@aws-sdk/client-lambda");
const {
  DynamoDBClient,
  ListTablesCommand,
  DescribeTableCommand,
} = require("@aws-sdk/client-dynamodb");
const {
  SQSClient,
  ListQueuesCommand,
  GetQueueAttributesCommand,
} = require("@aws-sdk/client-sqs");
const {
  APIGatewayClient,
  GetRestApisCommand,
} = require("@aws-sdk/client-api-gateway");

const app = express();
app.use(cors());
app.use(express.json());

// Serve dashboard.html at http://localhost:3001
app.use(express.static(path.join(__dirname)));

// ─── AWS Client Factory ─────────────────────────────────────────────────────
function makeClients(region, accessKeyId, secretAccessKey, sessionToken) {
  const creds =
    accessKeyId && secretAccessKey
      ? { credentials: { accessKeyId, secretAccessKey, sessionToken } }
      : {}; // fall back to env / instance profile
  const cfg = { region: region || process.env.AWS_REGION || "us-east-1", ...creds };
  return {
    cw: new CloudWatchClient(cfg),
    cwl: new CloudWatchLogsClient(cfg),
    lambda: new LambdaClient(cfg),
    dynamo: new DynamoDBClient(cfg),
    sqs: new SQSClient(cfg),
    apigw: new APIGatewayClient(cfg),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function timeRange(hours = 24) {
  const end = new Date();
  const start = new Date(end - hours * 60 * 60 * 1000);
  return { start, end };
}

function metricQuery(id, namespace, metricName, stat, dimensions, period = 300) {
  return {
    Id: id,
    MetricStat: {
      Metric: { Namespace: namespace, MetricName: metricName, Dimensions: dimensions },
      Period: period,
      Stat: stat,
    },
  };
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * POST /api/connect
 * Validates credentials and returns account info
 */
app.post("/api/connect", async (req, res) => {
  const { accessKeyId, secretAccessKey, region, sessionToken } = req.body;
  try {
    const { lambda } = makeClients(region, accessKeyId, secretAccessKey, sessionToken);
    const data = await lambda.send(new ListFunctionsCommand({ MaxItems: 1 }));
    res.json({ ok: true, region, functionCount: data.Functions?.length ?? 0 });
  } catch (err) {
    res.status(401).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/metrics
 * Returns all KPI metrics in one call
 */
app.post("/api/metrics", async (req, res) => {
  const { accessKeyId, secretAccessKey, region, sessionToken } = req.body;
  const { cw } = makeClients(region, accessKeyId, secretAccessKey, sessionToken);
  const { start, end } = timeRange(24);

  try {
    const cmd = new GetMetricDataCommand({
      StartTime: start,
      EndTime: end,
      MetricDataQueries: [
        metricQuery("invocations", "AWS/Lambda", "Invocations", "Sum", [], 3600),
        metricQuery("errors", "AWS/Lambda", "Errors", "Sum", [], 3600),
        metricQuery("duration", "AWS/Lambda", "Duration", "Average", [], 3600),
        metricQuery("throttles", "AWS/Lambda", "Throttles", "Sum", [], 3600),
        metricQuery("apip99", "AWS/ApiGateway", "Latency", "p99", [], 3600),
        metricQuery("apicount", "AWS/ApiGateway", "Count", "Sum", [], 3600),
        metricQuery("ddbRcu", "AWS/DynamoDB", "ConsumedReadCapacityUnits", "Sum", [], 3600),
        metricQuery("ddbWcu", "AWS/DynamoDB", "ConsumedWriteCapacityUnits", "Sum", [], 3600),
      ],
    });

    const result = await cw.send(cmd);
    const metric = (id) => {
      const m = result.MetricDataResults?.find((r) => r.Id === id);
      return m?.Values ?? [];
    };

    const sum = (arr) => arr.reduce((a, b) => a + b, 0);
    const avg = (arr) => (arr.length ? sum(arr) / arr.length : 0);
    const last = (arr) => arr[arr.length - 1] ?? 0;

    const totalInvoc = sum(metric("invocations"));
    const totalErrors = sum(metric("errors"));
    const errorRate = totalInvoc > 0 ? ((totalErrors / totalInvoc) * 100).toFixed(2) : "0.00";

    res.json({
      invocations: { value: totalInvoc, hourly: metric("invocations") },
      errors: { value: totalErrors, rate: parseFloat(errorRate) },
      duration: { avg: Math.round(avg(metric("duration"))) },
      throttles: { value: sum(metric("throttles")) },
      apiLatencyP99: { value: Math.round(last(metric("apip99"))) },
      apiRequests: { value: sum(metric("apicount")) },
      ddbRcu: { value: Math.round(sum(metric("ddbRcu"))) },
      ddbWcu: { value: Math.round(sum(metric("ddbWcu"))) },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/invocations-chart
 * Returns hourly invocation + error data for the line chart
 */
app.post("/api/invocations-chart", async (req, res) => {
  const { accessKeyId, secretAccessKey, region, sessionToken } = req.body;
  const { cw } = makeClients(region, accessKeyId, secretAccessKey, sessionToken);
  const { start, end } = timeRange(24);

  try {
    const cmd = new GetMetricDataCommand({
      StartTime: start,
      EndTime: end,
      MetricDataQueries: [
        metricQuery("inv", "AWS/Lambda", "Invocations", "Sum", [], 3600),
        metricQuery("err", "AWS/Lambda", "Errors", "Sum", [], 3600),
      ],
    });
    const result = await cw.send(cmd);
    const inv = result.MetricDataResults?.find((r) => r.Id === "inv");
    const err = result.MetricDataResults?.find((r) => r.Id === "err");

    res.json({
      timestamps: inv?.Timestamps ?? [],
      invocations: inv?.Values ?? [],
      errors: err?.Values ?? [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/lambda-functions
 * Returns list of Lambda functions with cold start metrics
 */
app.post("/api/lambda-functions", async (req, res) => {
  const { accessKeyId, secretAccessKey, region, sessionToken } = req.body;
  const { lambda, cw } = makeClients(region, accessKeyId, secretAccessKey, sessionToken);

  try {
    const list = await lambda.send(new ListFunctionsCommand({ MaxItems: 50 }));
    const functions = list.Functions ?? [];

    // Get init duration (cold start proxy) for each function
    const { start, end } = timeRange(24);
    const queries = functions.slice(0, 10).map((fn, i) =>
      metricQuery(`fn${i}`, "AWS/Lambda", "InitDuration", "Average", [
        { Name: "FunctionName", Value: fn.FunctionName },
      ], 86400)
    );

    let coldStarts = {};
    if (queries.length) {
      const cwResult = await cw.send(
        new GetMetricDataCommand({ StartTime: start, EndTime: end, MetricDataQueries: queries })
      );
      cwResult.MetricDataResults?.forEach((r, i) => {
        const fn = functions[i];
        if (fn) coldStarts[fn.FunctionName] = r.Values?.[0] ?? 0;
      });
    }

    res.json({
      functions: functions.slice(0, 10).map((fn) => ({
        name: fn.FunctionName,
        runtime: fn.Runtime,
        memory: fn.MemorySize,
        timeout: fn.Timeout,
        lastModified: fn.LastModified,
        coldStartMs: Math.round(coldStarts[fn.FunctionName] ?? 0),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/dynamodb
 * Returns DynamoDB table list with capacity stats
 */
app.post("/api/dynamodb", async (req, res) => {
  const { accessKeyId, secretAccessKey, region, sessionToken } = req.body;
  const { dynamo, cw } = makeClients(region, accessKeyId, secretAccessKey, sessionToken);

  try {
    const list = await dynamo.send(new ListTablesCommand({}));
    const tableNames = (list.TableNames ?? []).slice(0, 6);

    const tables = await Promise.all(
      tableNames.map(async (name) => {
        const desc = await dynamo.send(new DescribeTableCommand({ TableName: name }));
        const t = desc.Table;

        const { start, end } = timeRange(1);
        const dims = [{ Name: "TableName", Value: name }];
        const cwResult = await cw.send(
          new GetMetricDataCommand({
            StartTime: start,
            EndTime: end,
            MetricDataQueries: [
              metricQuery("rcu", "AWS/DynamoDB", "ConsumedReadCapacityUnits", "Sum", dims, 3600),
              metricQuery("wcu", "AWS/DynamoDB", "ConsumedWriteCapacityUnits", "Sum", dims, 3600),
            ],
          })
        );

        const rcu = cwResult.MetricDataResults?.find((r) => r.Id === "rcu")?.Values?.[0] ?? 0;
        const wcu = cwResult.MetricDataResults?.find((r) => r.Id === "wcu")?.Values?.[0] ?? 0;
        const provRcu = t.ProvisionedThroughput?.ReadCapacityUnits ?? 0;
        const provWcu = t.ProvisionedThroughput?.WriteCapacityUnits ?? 0;

        return {
          name,
          itemCount: t.ItemCount ?? 0,
          sizeBytes: t.TableSizeBytes ?? 0,
          status: t.TableStatus,
          rcuConsumed: Math.round(rcu),
          wcuConsumed: Math.round(wcu),
          rcuProvisioned: provRcu,
          wcuProvisioned: provWcu,
          rcuPercent: provRcu > 0 ? Math.round((rcu / provRcu) * 100) : null,
          wcuPercent: provWcu > 0 ? Math.round((wcu / provWcu) * 100) : null,
        };
      })
    );

    res.json({ tables });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sqs
 * Returns SQS queue depths including DLQ detection
 */
app.post("/api/sqs", async (req, res) => {
  const { accessKeyId, secretAccessKey, region, sessionToken } = req.body;
  const { sqs } = makeClients(region, accessKeyId, secretAccessKey, sessionToken);

  try {
    const list = await sqs.send(new ListQueuesCommand({ MaxResults: 20 }));
    const urls = list.QueueUrls ?? [];

    const queues = await Promise.all(
      urls.map(async (url) => {
        const attrs = await sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: url,
            AttributeNames: [
              "ApproximateNumberOfMessages",
              "ApproximateNumberOfMessagesNotVisible",
              "ApproximateNumberOfMessagesDelayed",
              "QueueArn",
            ],
          })
        );
        const a = attrs.Attributes ?? {};
        const name = url.split("/").pop();
        return {
          name,
          url,
          depth: parseInt(a.ApproximateNumberOfMessages ?? "0"),
          inFlight: parseInt(a.ApproximateNumberOfMessagesNotVisible ?? "0"),
          delayed: parseInt(a.ApproximateNumberOfMessagesDelayed ?? "0"),
          isDLQ: name.toLowerCase().includes("dlq") || name.toLowerCase().includes("dead"),
        };
      })
    );

    res.json({ queues });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/logs
 * Returns recent CloudWatch log entries across all log groups
 */
app.post("/api/logs", async (req, res) => {
  const { accessKeyId, secretAccessKey, region, sessionToken, filterPattern } = req.body;
  const { cwl } = makeClients(region, accessKeyId, secretAccessKey, sessionToken);

  try {
    // Get Lambda log groups
    const groups = await cwl.send(
      new DescribeLogGroupsCommand({ logGroupNamePrefix: "/aws/lambda/", limit: 10 })
    );
    const logGroupNames = (groups.logGroups ?? []).map((g) => g.logGroupName);

    const startTime = Date.now() - 3600 * 1000; // last 1 hour
    const allEvents = [];

    await Promise.all(
      logGroupNames.slice(0, 5).map(async (logGroupName) => {
        try {
          const result = await cwl.send(
            new FilterLogEventsCommand({
              logGroupName,
              startTime,
              limit: 10,
              filterPattern: filterPattern || "?ERROR ?WARN ?error ?warn",
            })
          );
          (result.events ?? []).forEach((e) => {
            allEvents.push({
              timestamp: e.timestamp,
              message: e.message?.trim(),
              logGroup: logGroupName,
              level: /error|exception|failed/i.test(e.message ?? "")
                ? "error"
                : /warn|timeout|retry/i.test(e.message ?? "")
                ? "warn"
                : "info",
            });
          });
        } catch (_) {
          // skip groups we can't access
        }
      })
    );

    allEvents.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    res.json({ events: allEvents.slice(0, 30) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/service-health
 * Quick health summary across all services
 */
app.post("/api/service-health", async (req, res) => {
  const { accessKeyId, secretAccessKey, region, sessionToken } = req.body;
  const clients = makeClients(region, accessKeyId, secretAccessKey, sessionToken);

  const check = async (name, fn) => {
    try {
      const result = await fn(clients);
      return { name, ...result, status: "ok" };
    } catch (e) {
      return { name, status: "error", error: e.message };
    }
  };

  const results = await Promise.allSettled([
    check("lambda", async ({ lambda }) => {
      const r = await lambda.send(new ListFunctionsCommand({ MaxItems: 100 }));
      return { count: r.Functions?.length ?? 0 };
    }),
    check("dynamodb", async ({ dynamo }) => {
      const r = await dynamo.send(new ListTablesCommand({}));
      return { count: r.TableNames?.length ?? 0 };
    }),
    check("sqs", async ({ sqs }) => {
      const r = await sqs.send(new ListQueuesCommand({ MaxResults: 100 }));
      return { count: r.QueueUrls?.length ?? 0 };
    }),
    check("apigateway", async ({ apigw }) => {
      const r = await apigw.send(new GetRestApisCommand({}));
      return { count: r.items?.length ?? 0 };
    }),
  ]);

  const health = results.map((r) => (r.status === "fulfilled" ? r.value : { status: "error" }));
  res.json({ health });
});

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅  ServerlessOps API running on http://localhost:${PORT}`);
  console.log(`    Region: ${process.env.AWS_REGION || "us-east-1 (default)"}`);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'DASHBOARD.html'));
});