# Advanced Analytics & Statistical Analysis

ProDisco isn't just for fetching Kubernetes resources - it includes powerful **statistical analysis** capabilities for in-depth cluster observability. By combining Prometheus metrics with the `simple-statistics` library, you can perform anomaly detection, trend analysis, and correlation analysis directly in the sandbox.

---

## Table of Contents

- [Available Analytics Library](#available-analytics-library)
- [Discovering Analytics Functions](#discovering-analytics-functions)
- [Example Workflows](#example-workflows)
  - [Cluster Health Report with Statistics](#1-cluster-health-report-with-statistics)
  - [Memory Leak Detection](#2-memory-leak-detection)
  - [Network Anomaly Detection](#3-network-anomaly-detection)
  - [Performance Correlation Analysis](#4-performance-correlation-analysis)
- [Quick Reference: Prompt Examples](#quick-reference-prompt-examples)

---

## Available Analytics Library

The sandbox provides the `simple-statistics` library for statistical analysis:

| Library | Version | Purpose | Key Functions |
|---------|---------|---------|---------------|
| **simple-statistics** | 7.8.8 | Descriptive stats, distributions, regression | `mean`, `median`, `standardDeviation`, `zScore`, `linearRegression`, `sampleCorrelation` |

---

## Discovering Analytics Functions

Use `searchTools` with `documentType: "function"` to discover available analytics functions:

```typescript
// List all analytics functions
{ documentType: "function", library: "simple-statistics" }

// Search for specific functions
{ methodName: "regression", documentType: "function" }

// Find correlation functions
{ methodName: "correlation", documentType: "function" }
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

## Quick Reference: Prompt Examples

Copy these prompts to get started with analytics:

| Use Case | Prompt |
|----------|--------|
| **Cluster Health** | "Analyze CPU and memory usage across all pods. Calculate mean, median, standard deviation, and identify outliers using z-scores. Show pods above the 95th percentile." |
| **Memory Leaks** | "Check for memory leaks. Fetch memory usage over 2 hours and use linear regression to identify pods with increasing memory. Predict memory in 1 hour." |
| **Network Anomalies** | "Analyze network traffic and detect anomalies. Find receive/transmit rates more than 2 standard deviations from normal." |
| **Correlation** | "Find correlations between CPU and memory usage for prometheus pods. Tell me if high CPU correlates with high memory." |

---

## See Also

- [searchTools Reference](search-tools.md) - Complete API documentation
- [gRPC Sandbox Architecture](grpc-sandbox-architecture.md) - How the sandbox executes code
- [Integration Testing](integration-testing.md) - Test your analytics workflows
