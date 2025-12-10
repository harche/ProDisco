# Advanced Analytics & Statistical Analysis

ProDisco isn't just for fetching Kubernetes resources - it includes powerful **statistical analysis, machine learning, and signal processing** capabilities for in-depth cluster observability. By combining Prometheus metrics with analytics libraries, you can perform anomaly detection, capacity forecasting, correlation analysis, and periodic pattern detection directly in the sandbox.

---

## Table of Contents

- [Available Analytics Libraries](#available-analytics-libraries)
- [Discovering Analytics Functions](#discovering-analytics-functions)
- [Example Workflows](#example-workflows)
  - [Cluster Health Report with Statistics](#1-cluster-health-report-with-statistics)
  - [Memory Leak Detection](#2-memory-leak-detection)
  - [Network Anomaly Detection](#3-network-anomaly-detection)
  - [Performance Correlation Analysis](#4-performance-correlation-analysis)
  - [Periodic Pattern Detection (FFT)](#5-periodic-pattern-detection-fft)
  - [Capacity Planning & Forecasting](#6-capacity-planning--forecasting)
- [Quick Reference: Prompt Examples](#quick-reference-prompt-examples)

---

## Available Analytics Libraries

The sandbox provides four pre-installed analytics libraries:

| Library | Version | Purpose | Key Functions |
|---------|---------|---------|---------------|
| **simple-statistics** | 7.8.8 | Descriptive stats, distributions | `mean`, `median`, `standardDeviation`, `zScore`, `linearRegression`, `sampleCorrelation` |
| **ml-regression** | 5.0.0 | Advanced regression models | `PolynomialRegression`, `ExponentialRegression`, `PowerRegression` |
| **mathjs** | 14.5.2 | Matrix operations, linear algebra | `matrix`, `multiply`, `transpose`, `inv`, `det`, `eigs` |
| **fft-js** | 0.0.12 | Fast Fourier Transform | `fft`, `ifft`, `util.fftMag`, `util.fftFreq` |

---

## Discovering Analytics Functions

Use `searchTools` with `mode: "analytics"` to discover available functions:

```typescript
// List all analytics functions
{ mode: "analytics" }

// Filter by library
{ mode: "analytics", library: "simple-statistics" }

// Search for specific functions
{ mode: "analytics", functionPattern: "regression" }

// Find correlation functions
{ mode: "analytics", functionPattern: "correlation" }
```

---

## Example Workflows

### 1. Cluster Health Report with Statistics

**Prompt:**
> Analyze the CPU and memory usage across all pods in my cluster. Calculate mean, median, standard deviation, and identify any outliers using z-scores. Show me which pods are consuming resources above the 95th percentile.

**What it does:**
- Queries CPU and memory metrics for all pods
- Calculates descriptive statistics (mean, median, std dev, min, max)
- Computes z-scores to identify statistical outliers
- Finds pods above the 95th percentile

**Example Output:**
```
CPU USAGE ANALYSIS
==================
Total Pods Analyzed: 15
Mean:                8.60 millicores
Median:              2.11 millicores
Std Deviation:       12.21 millicores
95th Percentile:     46.74 millicores

PODS ABOVE 95TH PERCENTILE:
┌──────────────────────────────────────────────────────────────────┐
│ NAMESPACE/POD                              │ CPU (mc) │ Z-SCORE │
├──────────────────────────────────────────────────────────────────┤
│ kube-system/kube-apiserver-kind-control-pl │     46.7 │    3.12 │ ⚠️
└──────────────────────────────────────────────────────────────────┘

STATISTICAL OUTLIERS (|z-score| > 2):
└─ kube-system/kube-apiserver: 46.7 mc (z=3.12, HIGH)
```

**Key Libraries Used:**
```typescript
const ss = require('simple-statistics');

const mean = ss.mean(values);
const median = ss.median(values);
const stdDev = ss.standardDeviation(values);
const percentile95 = ss.quantile(values, 0.95);
const zScore = (value - mean) / stdDev;
```

---

### 2. Memory Leak Detection

**Prompt:**
> Check for potential memory leaks in my cluster. Fetch memory usage over the last 2 hours and use linear regression to identify pods with steadily increasing memory. Predict what the memory will be in 1 hour.

**What it does:**
- Fetches 2 hours of memory time-series data per pod
- Fits linear regression to each pod's memory trend
- Calculates growth rate (MB/hour)
- Projects memory usage 1 hour into the future
- Flags pods with concerning growth patterns

**Example Output:**
```
MEMORY LEAK DETECTION
=====================
Pod: prometheus-grafana
   Current Memory: 702.3 MB
   Trend: +0.84 MB/hour
   R² (fit quality): 0.89
   Predicted (1 hour): 703.1 MB
   ⚠️ Potential leak - consistent upward trend

Pod: alertmanager
   Current Memory: 48.2 MB
   Trend: -0.02 MB/hour
   ✅ Stable - no leak detected
```

**Key Libraries Used:**
```typescript
const ss = require('simple-statistics');

// Fit linear regression: memory vs time
const pairs = times.map((t, i) => [t, memoryValues[i]]);
const regression = ss.linearRegression(pairs);
const regressionLine = ss.linearRegressionLine(regression);

// Predict future value
const predictedMemory = regressionLine(currentTime + 60); // 1 hour ahead
const growthRate = regression.m * 60; // MB per hour
```

---

### 3. Network Anomaly Detection

**Prompt:**
> Analyze network traffic patterns in my cluster and detect anomalies. Use statistical methods to find any network receive/transmit rates that are more than 2 standard deviations from normal.

**What it does:**
- Queries network receive/transmit bytes rate over time
- Calculates mean and standard deviation per interface
- Identifies data points with |z-score| > 2
- Classifies anomalies as HIGH (spike) or LOW (drop)

**Example Output:**
```
NETWORK TRAFFIC ANOMALY DETECTION
=================================
Analysis Period: Last 1 hour (1-minute intervals)
Threshold: ±2 standard deviations from mean

RECEIVE TRAFFIC (eth0):
   Mean Rate: 0.5 KB/s
   Std Dev:   0.1 KB/s

   ⚠️ ANOMALIES DETECTED: 5
      └─ 2025-12-09T23:59:20Z: 0.8 KB/s (z-score: 3.15, HIGH)
      └─ 2025-12-10T00:00:20Z: 0.8 KB/s (z-score: 3.14, HIGH)
      └─ 2025-12-10T00:01:20Z: 0.8 KB/s (z-score: 3.13, HIGH)

INTERPRETATION:
The eth0 interface experienced a traffic spike around midnight,
suggesting a scheduled job or automated task.
```

**Key Libraries Used:**
```typescript
const ss = require('simple-statistics');

const mean = ss.mean(values);
const stdDev = ss.standardDeviation(values);

values.forEach((value, i) => {
  const zScore = (value - mean) / stdDev;
  if (Math.abs(zScore) > 2) {
    anomalies.push({
      time: timestamps[i],
      value,
      zScore,
      direction: zScore > 0 ? 'HIGH' : 'LOW'
    });
  }
});
```

---

### 4. Performance Correlation Analysis

**Prompt:**
> Find correlations between CPU usage and memory usage for the prometheus pods. Tell me if high CPU correlates with high memory usage.

**What it does:**
- Fetches time-series data for both CPU and memory
- Calculates Pearson correlation coefficient (r)
- Computes R² (coefficient of determination)
- Fits linear regression to quantify relationship
- Interprets correlation strength

**Example Output:**
```
CPU vs MEMORY CORRELATION ANALYSIS - PROMETHEUS PODS
====================================================

PER-POD ANALYSIS:
┌─────────────────────────────────────────────────────────────┐
│ Pod: prometheus-grafana                                      │
│ Pearson Correlation (r):  -0.1635                           │
│ R-squared (r²):            0.0267                           │
│ Correlation Strength:     ⚪ NEGLIGIBLE NEGATIVE             │
│ Data Points:              61                                 │
├─────────────────────────────────────────────────────────────┤
│ Linear Regression: Memory = -0.036 × CPU + 702.69           │
│ For every 1mc CPU increase, memory decreases by 0.036 MB    │
└─────────────────────────────────────────────────────────────┘

CONCLUSION:
There is NO significant correlation between CPU and memory usage.
Average correlation across pods: -0.033
CPU and memory are used independently by these pods.
```

**Key Libraries Used:**
```typescript
const ss = require('simple-statistics');

// Pearson correlation coefficient
const correlation = ss.sampleCorrelation(cpuValues, memValues);
const rSquared = correlation * correlation;

// Linear regression
const pairs = cpuValues.map((cpu, i) => [cpu, memValues[i]]);
const regression = ss.linearRegression(pairs);
```

---

### 5. Periodic Pattern Detection (FFT)

**Prompt:**
> Use FFT analysis on the node CPU idle time to detect any periodic patterns or recurring spikes. Are there any dominant frequencies that suggest scheduled jobs or cron tasks?

**What it does:**
- Fetches 2+ hours of CPU time-series data
- Applies Fast Fourier Transform (FFT)
- Identifies dominant frequency components
- Converts frequencies to human-readable periods
- Interprets patterns (cron jobs, scraping intervals, etc.)

**Example Output:**
```
FFT ANALYSIS - NODE CPU IDLE TIME
=================================
Sampling Rate: Every 30 seconds
Nyquist Frequency: 0.0167 Hz (can detect periods >= 60s)

TOP FREQUENCY COMPONENTS:
┌────────┬──────────────┬──────────────┬───────────────┬──────────────┐
│ Rank   │ Frequency    │ Period       │ Magnitude     │ Significant? │
├────────┼──────────────┼──────────────┼───────────────┼──────────────┤
│    1   │     0.26 mHz │ 1.07 hours   │    0.052701   │     ✅ YES   │
│    2   │     0.65 mHz │  25.6 min    │    0.036934   │     ✅ YES   │
│    3   │     0.39 mHz │  42.7 min    │    0.035604   │     ✅ YES   │
└────────┴──────────────┴──────────────┴───────────────┴──────────────┘

DETECTED PERIODIC PATTERNS:
📍 Period: 1.07 hours
   ⏰ Hourly pattern (likely cron job)

📍 Period: 25.6 minutes
   📊 Periodic activity (controller reconciliation?)
```

**Key Libraries Used:**
```typescript
const fft = require('fft-js').fft;
const fftUtil = require('fft-js').util;

// Pad to power of 2
const n = Math.pow(2, Math.ceil(Math.log2(signal.length)));

// Remove DC component (mean)
const mean = ss.mean(signal);
const centered = signal.map(v => v - mean);

// Perform FFT
const phasors = fft(centered);
const frequencies = fftUtil.fftFreq(phasors, sampleRate);
const magnitudes = fftUtil.fftMag(phasors);
```

---

### 6. Capacity Planning & Forecasting

**Prompt:**
> Analyze resource usage trends for all containers in the monitoring namespace. Use polynomial regression to forecast when we might hit resource limits based on current growth rates.

**What it does:**
- Fetches historical CPU/memory data with resource limits
- Fits polynomial regression (degree 1-2) to trends
- Compares linear vs quadratic models using R²
- Projects forward to find when limits will be breached
- Prioritizes alerts by severity (Critical/Warning/Info)

**Example Output:**
```
RESOURCE USAGE TREND ANALYSIS & FORECASTING
==========================================

POLYNOMIAL REGRESSION ANALYSIS:
📦 prometheus-prometheus/prometheus
   CPU Usage:
      Current:     17.99 millicores
      Trend:       +0.5449 mc/hour
      Model:       Polynomial degree 2 (R²=0.2056)
      Limit:       500 millicores
      📈 Projected: CPU limit in ~884 hours (linear)

   Memory Usage:
      Current:     292.57 MB
      Trend:       +0.0367 MB/hour
      Model:       Polynomial degree 1 (R²=0.0000)
      Limit:       1024 MB
      ✅ Stable: No limit breach expected

FORECAST SUMMARY:
✅ NO CRITICAL RESOURCE LIMIT BREACHES FORECASTED

Notable Trends:
┌────────────────────────────────────┬──────────┬─────────────┐
│ Container                          │ Resource │ Growth/hr   │
├────────────────────────────────────┼──────────┼─────────────┤
│ prometheus/config-reloader         │ Memory   │ +0.84 MB    │
│ alertmanager/config-reloader       │ Memory   │ +0.53 MB    │
│ prometheus/prometheus              │ CPU      │ +0.54 mc    │
└────────────────────────────────────┴──────────┴─────────────┘
```

**Key Libraries Used:**
```typescript
const PolynomialRegression = require('ml-regression').PolynomialRegression;

// Fit polynomial models
const linear = new PolynomialRegression(x, y, 1);
const quadratic = new PolynomialRegression(x, y, 2);

// Select best model based on R²
const linearR2 = linear.score(x, y).r2;
const quadR2 = quadratic.score(x, y).r2;
const bestModel = quadR2 > linearR2 + 0.05 ? quadratic : linear;

// Forecast when limit is reached
for (let t = currentTime; t <= currentTime + 1440; t += 5) {
  if (bestModel.predict(t) >= limit) {
    timeToLimit = t - currentTime;
    break;
  }
}
```

---

## Quick Reference: Prompt Examples

Copy these prompts to get started with advanced analytics:

| Use Case | Prompt |
|----------|--------|
| **Cluster Health** | "Analyze CPU and memory usage across all pods. Calculate mean, median, standard deviation, and identify outliers using z-scores. Show pods above the 95th percentile." |
| **Memory Leaks** | "Check for memory leaks. Fetch memory usage over 2 hours and use linear regression to identify pods with increasing memory. Predict memory in 1 hour." |
| **Network Anomalies** | "Analyze network traffic and detect anomalies. Find receive/transmit rates more than 2 standard deviations from normal." |
| **Correlation** | "Find correlations between CPU and memory usage for prometheus pods. Tell me if high CPU correlates with high memory." |
| **Periodic Patterns** | "Use FFT analysis on node CPU to detect periodic patterns. Are there dominant frequencies suggesting scheduled jobs?" |
| **Capacity Planning** | "Analyze resource trends for monitoring namespace. Use polynomial regression to forecast when we might hit resource limits." |

---

## See Also

- [searchTools Reference](search-tools.md) - Complete API documentation
- [gRPC Sandbox Architecture](grpc-sandbox-architecture.md) - How the sandbox executes code
- [Integration Testing](integration-testing.md) - Test your analytics workflows
