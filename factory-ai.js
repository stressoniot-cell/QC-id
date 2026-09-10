(function(){
'use strict';

// ============================================================
// UTILITY FUNCTIONS
// ============================================================
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => 
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])
);
const num = (v, d = 0) => Number.isFinite(Number(v)) ? Number(v) : d;
const qty = v => num(v).toLocaleString(undefined, { maximumFractionDigits: 1 });
const pct = v => v == null || !Number.isFinite(Number(v)) ? '—' : (Number(v) * 100).toFixed(1) + '%';

// ============================================================
// ADVANCED ANALYTICS ENGINE
// ============================================================
class AdvancedAnalytics {
  constructor(context) {
    this.context = context;
    this.cache = new Map();
    this.CACHE_TTL = 60000; // 1 minute
  }

  _cacheKey(type, params) {
    return `${type}:${JSON.stringify(params)}`;
  }

  _cached(key, fn) {
    if (this.cache.has(key)) {
      const { data, timestamp } = this.cache.get(key);
      if (Date.now() - timestamp < this.CACHE_TTL) {
        return data;
      }
    }
    const data = fn();
    this.cache.set(key, { data, timestamp: Date.now() });
    return data;
  }

  // ============================================================
  // MANPOWER CONTROL ANALYTICS
  // ============================================================

  analyzeManpower(date, machineId = null) {
    const key = this._cacheKey('manpower', { date, machineId });
    return this._cached(key, () => {
      const machines = machineId ? [machineId] : (this.context.constants.machines || []);
      const operators = {};
      const shiftCoverage = { A: { count: 0, production: 0 }, B: { count: 0, production: 0 } };
      let totalOperators = 0;
      let unassignedProduction = 0;
      let totalProduction = 0;

      machines.forEach(id => {
        const d = this.context.overviewData[id] || {};
        const sessions = Object.values(d.sessions || {});
        const events = Object.values(d.events || {});
        const todayEvents = events.filter(e => this.context.dateKeyFor(e.timestamp) === date);

        // Track sessions
        sessions.forEach(s => {
          if (this.context.dateKeyFor(s.punchIn) === date) {
            const opId = s.operatorId || 'Unassigned';
            if (!operators[opId]) {
              operators[opId] = { 
                name: this.context.operatorNames?.[opId] || opId, 
                sessions: 0, 
                machines: new Set(),
                production: 0,
                shift: this.context.shiftFor(s.punchIn),
                active: s.punchOut ? false : true,
                punchIn: s.punchIn,
                punchOut: s.punchOut || Math.floor(Date.now() / 1000)
              };
            }
            operators[opId].sessions++;
            operators[opId].machines.add(id);
            operators[opId].punchOut = s.punchOut || Math.floor(Date.now() / 1000);
            
            // Count production during this session
            const sessionEvents = todayEvents.filter(e => 
              e.timestamp >= s.punchIn && e.timestamp <= (s.punchOut || Infinity)
            );
            const prod = sessionEvents.reduce((a, e) => a + num(e.count), 0);
            operators[opId].production += prod;
            
            // Shift tracking
            const shift = this.context.shiftFor(s.punchIn);
            shiftCoverage[shift].count++;
            shiftCoverage[shift].production += prod;
          }
        });

        // Count unassigned production
        todayEvents.forEach(e => {
          totalProduction += num(e.count);
          // Check if this event is covered by any session
          const covered = sessions.some(s => 
            e.timestamp >= s.punchIn && e.timestamp <= (s.punchOut || Infinity)
          );
          if (!covered) {
            unassignedProduction += num(e.count);
          }
        });
      });

      totalOperators = Object.keys(operators).length;

      // Calculate utilization
      const opArray = Object.values(operators).sort((a, b) => b.production - a.production);
      const totalAssigned = opArray.reduce((a, o) => a + o.production, 0);
      const coverageRate = totalProduction > 0 ? (totalAssigned / totalProduction) * 100 : 0;

      // Calculate average shift duration
      const avgShiftDuration = opArray.length ? 
        opArray.reduce((a, o) => a + (o.punchOut - o.punchIn) / 60, 0) / opArray.length : 0;

      // Productivity per operator
      const avgProductivity = opArray.length ? totalAssigned / opArray.length : 0;
      const maxProductivity = opArray.length ? Math.max(...opArray.map(o => o.production)) : 0;
      const minProductivity = opArray.length ? Math.min(...opArray.map(o => o.production)) : 0;

      // Shift balance
      const shiftBalance = shiftCoverage.A.production + shiftCoverage.B.production > 0 ?
        Math.abs(shiftCoverage.A.production - shiftCoverage.B.production) / 
        Math.max(shiftCoverage.A.production, shiftCoverage.B.production) : 0;

      // Utilization by machine
      const machineUtilization = {};
      machines.forEach(id => {
        const d = this.context.overviewData[id] || {};
        const sessions = Object.values(d.sessions || {});
        const todaySessions = sessions.filter(s => this.context.dateKeyFor(s.punchIn) === date);
        machineUtilization[id] = {
          operators: new Set(todaySessions.map(s => s.operatorId)).size,
          sessions: todaySessions.length,
          active: todaySessions.some(s => !s.punchOut)
        };
      });

      return {
        date,
        operators: opArray,
        totalOperators,
        shiftCoverage,
        coverageRate,
        unassignedProduction,
        totalProduction,
        avgShiftDuration,
        avgProductivity,
        maxProductivity,
        minProductivity,
        shiftBalance,
        machineUtilization,
        utilizationScore: coverageRate > 90 ? 'Excellent' : coverageRate > 75 ? 'Good' : coverageRate > 60 ? 'Fair' : 'Poor'
      };
    });
  }

  // ============================================================
  // SCRAP CONTROL ANALYTICS
  // ============================================================

  analyzeScrap(date, machineId = null) {
    const key = this._cacheKey('scrap', { date, machineId });
    return this._cached(key, () => {
      const machines = machineId ? [machineId] : (this.context.constants.machines || []);
      const scrapData = [];
      let totalScrap = 0;
      let totalProduction = 0;
      let scrapByReason = {};
      let scrapByOperator = {};
      let scrapByShift = { A: 0, B: 0 };

      machines.forEach(id => {
        const d = this.context.overviewData[id] || {};
        const events = Object.values(d.events || {});
        const todayEvents = events.filter(e => this.context.dateKeyFor(e.timestamp) === date);
        const production = todayEvents.reduce((a, e) => a + num(e.count), 0);
        totalProduction += production;

        const scrap = this.context.scrapForMachineDate(id, date);
        totalScrap += scrap;

        // Get scrap reasons from quality defects (approximation)
        const defects = this.context.rawQualitySnapshot?.[date]?.[id] || {};
        Object.values(defects).forEach(def => {
          if (def.defectType) {
            scrapByReason[def.defectType] = (scrapByReason[def.defectType] || 0) + num(def.quantity || 0);
          }
        });

        // Scrap by operator (from sessions)
        const sessions = Object.values(d.sessions || {});
        sessions.forEach(s => {
          if (this.context.dateKeyFor(s.punchIn) === date && s.scrapQty) {
            const opId = s.operatorId || 'Unassigned';
            scrapByOperator[opId] = (scrapByOperator[opId] || 0) + num(s.scrapQty);
            const shift = this.context.shiftFor(s.punchIn);
            scrapByShift[shift] = (scrapByShift[shift] || 0) + num(s.scrapQty);
          }
        });

        scrapData.push({
          machine: id,
          production,
          scrap,
          rate: production > 0 ? (scrap / production) * 100 : (scrap > 0 ? 100 : 0)
        });
      });

      const overallScrapRate = totalProduction > 0 ? (totalScrap / totalProduction) * 100 : 0;

      // Calculate scrap cost (assuming 100 units = $1, or adjust)
      const scrapCost = totalScrap * 0.01;

      // Identify scrap hotspots
      const hotspots = scrapData
        .filter(d => d.rate > 5)
        .sort((a, b) => b.rate - a.rate)
        .slice(0, 5);

      // Top scrap reasons
      const topReasons = Object.entries(scrapByReason)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

      // Top scrap operators
      const topOperators = Object.entries(scrapByOperator)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

      return {
        date,
        machines: scrapData,
        totalScrap,
        totalProduction,
        overallScrapRate,
        scrapCost,
        hotspots,
        topReasons,
        topOperators,
        scrapByShift,
        severity: overallScrapRate > 8 ? 'Critical' : overallScrapRate > 5 ? 'High' : overallScrapRate > 3 ? 'Medium' : 'Low'
      };
    });
  }

  // ============================================================
  // TECHNICAL PERFORMANCE ANALYTICS
  // ============================================================

  analyzeTechnicalPerformance(date, machineId = null) {
    const key = this._cacheKey('technical', { date, machineId });
    return this._cached(key, () => {
      const machines = machineId ? [machineId] : (this.context.constants.machines || []);
      const results = [];

      machines.forEach(id => {
        const d = this.context.overviewData[id] || {};
        const events = Object.values(d.events || {});
        const todayEvents = events.filter(e => this.context.dateKeyFor(e.timestamp) === date);
        const production = todayEvents.reduce((a, e) => a + num(e.count), 0);

        // Speed analysis
        let speedSamples = [];
        let sortedEvents = [...todayEvents].sort((a, b) => a.timestamp - b.timestamp);
        for (let i = 1; i < sortedEvents.length; i++) {
          const gap = sortedEvents[i].timestamp - sortedEvents[i-1].timestamp;
          if (gap > 0 && gap < 300) { // Only consider gaps < 5 min
            speedSamples.push(sortedEvents[i-1].count / gap * 60);
          }
        }

        const avgSpeed = speedSamples.length ? speedSamples.reduce((a, v) => a + v, 0) / speedSamples.length : 0;
        const maxSpeed = speedSamples.length ? Math.max(...speedSamples) : 0;
        const minSpeed = speedSamples.length ? Math.min(...speedSamples) : 0;
        const speedStdDev = speedSamples.length > 1 ? 
          Math.sqrt(speedSamples.reduce((a, v) => a + Math.pow(v - avgSpeed, 2), 0) / (speedSamples.length - 1)) : 0;

        // Downtime
        const downtimeRecords = this._getDowntimeForMachine(id, date);
        const downtimeMinutes = downtimeRecords.reduce((a, r) => a + num(r.durationMinutes), 0);
        const downtimeCount = downtimeRecords.length;

        // Availability
        const scheduledTime = 1440; // 24 hours in minutes
        const availability = scheduledTime > 0 ? (scheduledTime - downtimeMinutes) / scheduledTime : 0;

        // Performance (relative to ideal)
        const idealSpeed = this.context.rawTargetsSnapshot?.[id]?.[date]?.idealSpeed || null;
        const performance = idealSpeed && idealSpeed > 0 ? (avgSpeed / idealSpeed) : null;

        // Quality
        const defects = this._getQualityForMachine(id, date);
        const defectCount = defects.length;
        const defectQty = defects.reduce((a, d) => a + num(d.quantity || 0), 0);
        const quality = production > 0 ? Math.max(0, (production - defectQty) / production) : 1;

        // OEE
        const oee = (performance != null && quality != null) ? availability * performance * quality : null;

        // Speed consistency (coefficient of variation)
        const speedConsistency = avgSpeed > 0 ? (speedStdDev / avgSpeed) : 0;

        // Production rate by hour
        const hourlyRate = {};
        for (let h = 0; h < 24; h++) {
          const hourEvents = todayEvents.filter(e => {
            const hour = new Date((e.timestamp + this.context.constants.factoryUtcOffsetMinutes * 60) * 1000).getUTCHours();
            return hour === h;
          });
          hourlyRate[h] = hourEvents.reduce((a, e) => a + num(e.count), 0);
        }

        results.push({
          machine: id,
          production,
          avgSpeed,
          maxSpeed,
          minSpeed,
          speedStdDev,
          speedConsistency,
          downtimeMinutes,
          downtimeCount,
          availability,
          idealSpeed,
          performance,
          quality,
          oee,
          defectCount,
          defectQty,
          hourlyRate,
          speedSamples: speedSamples.length
        });
      });

      return results;
    });
  }

  // ============================================================
  // PREDICTIVE ANALYTICS
  // ============================================================

  predictProduction(machineId, daysAhead = 7) {
    const key = this._cacheKey('predict', { machineId, daysAhead });
    return this._cached(key, () => {
      const d = this.context.overviewData[machineId] || {};
      const events = Object.values(d.events || {});
      const today = this.context.getTodayKey();
      
      // Get last 30 days of production
      const dailyData = [];
      for (let i = 29; i >= 0; i--) {
        const day = new Date(today + 'T00:00:00Z');
        day.setUTCDate(day.getUTCDate() - i);
        const key = day.toISOString().slice(0, 10);
        const total = events.filter(e => this.context.dateKeyFor(e.timestamp) === key)
          .reduce((a, e) => a + num(e.count), 0);
        dailyData.push({ date: key, production: total });
      }

      // Simple moving average forecast
      const windowSize = 7;
      const recent = dailyData.slice(-windowSize);
      const avg = recent.reduce((a, d) => a + d.production, 0) / recent.length;
      
      // Trend analysis (linear regression)
      const n = dailyData.length;
      const indices = dailyData.map((_, i) => i);
      const prodValues = dailyData.map(d => d.production);
      const sumX = indices.reduce((a, v) => a + v, 0);
      const sumY = prodValues.reduce((a, v) => a + v, 0);
      const sumXY = indices.reduce((a, x, i) => a + x * prodValues[i], 0);
      const sumX2 = indices.reduce((a, x) => a + x * x, 0);
      const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
      const intercept = (sumY - slope * sumX) / n;

      // Generate forecast
      const forecast = [];
      for (let i = 1; i <= daysAhead; i++) {
        const day = new Date(today + 'T00:00:00Z');
        day.setUTCDate(day.getUTCDate() + i);
        const dateKey = day.toISOString().slice(0, 10);
        const trendValue = intercept + slope * (n + i - 1);
        // Blend trend with average
        const predicted = (trendValue * 0.3 + avg * 0.7);
        forecast.push({
          date: dateKey,
          predicted: Math.max(0, predicted),
          lower: Math.max(0, predicted * 0.8),
          upper: predicted * 1.2
        });
      }

      // Calculate confidence
      const residuals = dailyData.map((d, i) => Math.abs(d.production - (intercept + slope * i)));
      const mae = residuals.reduce((a, v) => a + v, 0) / residuals.length;
      const confidence = Math.max(0, Math.min(100, 100 - (mae / avg * 50)));

      return {
        machine: machineId,
        historical: dailyData,
        average: avg,
        trend: { slope, intercept },
        forecast,
        confidence,
        trendDirection: slope > 0 ? 'Increasing' : slope < 0 ? 'Decreasing' : 'Stable'
      };
    });
  }

  // ============================================================
  // ROOT CAUSE ENGINE
  // ============================================================

  findRootCauses(machineId, date) {
    const key = this._cacheKey('rootcause', { machineId, date });
    return this._cached(key, () => {
      const causes = [];
      const d = this.context.overviewData[machineId] || {};
      const events = Object.values(d.events || {});
      const todayEvents = events.filter(e => this.context.dateKeyFor(e.timestamp) === date);
      const production = todayEvents.reduce((a, e) => a + num(e.count), 0);

      // 1. Check downtime
      const downtime = this._getDowntimeForMachine(machineId, date);
      const downtimeMinutes = downtime.reduce((a, r) => a + num(r.durationMinutes), 0);
      if (downtimeMinutes > 30) {
        const reasons = {};
        downtime.forEach(r => {
          const reason = r.reason || 'Unspecified';
          reasons[reason] = (reasons[reason] || 0) + num(r.durationMinutes);
        });
        const top = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0];
        causes.push({
          type: 'downtime',
          severity: downtimeMinutes > 120 ? 'High' : 'Medium',
          description: `${downtimeMinutes} min downtime, primarily "${top ? top[0] : 'Unknown'}" (${top ? qty(top[1]) : 0} min)`,
          impact: `Reduced production by approx ${Math.round(downtimeMinutes / 60 * (30))} units`
        });
      }

      // 2. Check speed
      const speedSamples = [];
      let sortedEvents = [...todayEvents].sort((a, b) => a.timestamp - b.timestamp);
      for (let i = 1; i < sortedEvents.length; i++) {
        const gap = sortedEvents[i].timestamp - sortedEvents[i-1].timestamp;
        if (gap > 0 && gap < 300) {
          speedSamples.push(sortedEvents[i-1].count / gap * 60);
        }
      }
      const avgSpeed = speedSamples.length ? speedSamples.reduce((a, v) => a + v, 0) / speedSamples.length : 0;
      const idealSpeed = this.context.rawTargetsSnapshot?.[machineId]?.[date]?.idealSpeed || null;
      if (idealSpeed && avgSpeed > 0 && avgSpeed < idealSpeed * 0.7) {
        causes.push({
          type: 'speed',
          severity: 'High',
          description: `Speed is ${((avgSpeed / idealSpeed) * 100).toFixed(1)}% of ideal (${qty(avgSpeed)} vs ${qty(idealSpeed)} units/min)`,
          impact: `Lost approx ${Math.round((idealSpeed - avgSpeed) * 60 * 8)} units over 8 hours`
        });
      }

      // 3. Check quality
      const defects = this._getQualityForMachine(machineId, date);
      const defectQty = defects.reduce((a, d) => a + num(d.quantity || 0), 0);
      if (defectQty > 10 || defects.length > 5) {
        const types = {};
        defects.forEach(d => {
          const type = d.defectType || 'Unknown';
          types[type] = (types[type] || 0) + num(d.quantity || 0);
        });
        const top = Object.entries(types).sort((a, b) => b[1] - a[1])[0];
        causes.push({
          type: 'quality',
          severity: defectQty > 50 ? 'High' : 'Medium',
          description: `${defects.length} defects (${qty(defectQty)} units), primarily "${top ? top[0] : 'Unknown'}"`,
          impact: `${(defectQty / (production + defectQty) * 100).toFixed(1)}% rejection rate`
        });
      }

      // 4. Check operator coverage
      const manpower = this.analyzeManpower(date, machineId);
      const machineOps = manpower.machineUtilization?.[machineId] || { operators: 0, sessions: 0 };
      if (machineOps.operators === 0 && production > 0) {
        causes.push({
          type: 'manpower',
          severity: 'High',
          description: 'Production detected but no operator session recorded',
          impact: 'Unassigned production may be misattributed or a data entry issue'
        });
      } else if (machineOps.operators === 0) {
        causes.push({
          type: 'manpower',
          severity: 'High',
          description: 'No operator assigned to this machine today',
          impact: 'Machine may be idle or unstaffed'
        });
      } else if (machineOps.operators === 1 && machineOps.sessions < 2) {
        causes.push({
          type: 'manpower',
          severity: 'Medium',
          description: `Only ${machineOps.sessions} session(s) from ${machineOps.operators} operator(s) today`,
          impact: 'May indicate incomplete shift coverage'
        });
      }

      // 5. Check for gaps in production (idle periods)
      const gaps = [];
      for (let i = 1; i < sortedEvents.length; i++) {
        const gap = sortedEvents[i].timestamp - sortedEvents[i-1].timestamp;
        if (gap > 300) { // > 5 min gap
          gaps.push(gap);
        }
      }
      if (gaps.length > 3) {
        const avgGap = gaps.reduce((a, v) => a + v, 0) / gaps.length;
        causes.push({
          type: 'idle',
          severity: gaps.length > 6 ? 'High' : 'Medium',
          description: `${gaps.length} idle gaps >5 min, average ${Math.round(avgGap / 60)} min`,
          impact: `Approx ${Math.round(gaps.reduce((a, v) => a + v, 0) / 60 * avgSpeed)} units lost to idle time`
        });
      }

      return {
        machine: machineId,
        date,
        production,
        causes: causes.sort((a, b) => {
          const order = { High: 0, Medium: 1, Low: 2 };
          return (order[a.severity] || 3) - (order[b.severity] || 3);
        }),
        severity: causes.some(c => c.severity === 'High') ? 'High' : 
                  causes.some(c => c.severity === 'Medium') ? 'Medium' : 'Low'
      };
    });
  }

  // ============================================================
  // HELPER METHODS
  // ============================================================

  _getDowntimeForMachine(machineId, date) {
    const snapshot = this.context.rawDowntimeSnapshot || {};
    const forDate = snapshot[date] || {};
    const forMachine = forDate[machineId] || {};
    return Object.values(forMachine).filter(r => r && typeof r.durationMinutes === 'number');
  }

  _getQualityForMachine(machineId, date) {
    const snapshot = this.context.rawQualitySnapshot || {};
    const forDate = snapshot[date] || {};
    const forMachine = forDate[machineId] || {};
    return Object.values(forMachine);
  }
}

// ============================================================
// ENHANCED AI ENGINE
// ============================================================
class EnhancedAIEngine {
  constructor(context) {
    this.context = context;
    this.analytics = new AdvancedAnalytics(context);
    this.memory = [];
    this.MAX_MEMORY = 30;
    this.actionHistory = [];
  }

  answer(query) {
    const trimmed = query.trim();
    if (!trimmed) return this._getHelpResponse();

    this._addToMemory('user', trimmed);
    const lower = trimmed.toLowerCase();

    // ============================================================
    // TECHNICAL MANPOWER CONTROL
    // ============================================================
    if (/manpower|staffing|headcount|personnel|workforce|coverage|utilization|shift coverage/.test(lower)) {
      return this._handleManpowerQuery(trimmed);
    }

    // ============================================================
    // SCRAP CONTROL & REDUCTION
    // ============================================================
    if (/scrap|waste|reduction|recycle|loss|yield|reject|salvage/.test(lower)) {
      return this._handleScrapQuery(trimmed);
    }

    // ============================================================
    // ROOT CAUSE ANALYSIS
    // ============================================================
    if (/root cause|why is|reason for|cause of|investigate|diagnose|troubleshoot/.test(lower)) {
      return this._handleRootCauseQuery(trimmed);
    }

    // ============================================================
    // PREDICTIVE FORECASTING
    // ============================================================
    if (/predict|forecast|will be|project|estimate|expect|future/.test(lower)) {
      return this._handleForecastQuery(trimmed);
    }

    // ============================================================
    // TECHNICAL PERFORMANCE
    // ============================================================
    if (/technical|performance|speed|efficiency|cycle time|throughput|oee|availability/.test(lower)) {
      return this._handleTechnicalQuery(trimmed);
    }

    // ============================================================
    // COMPARATIVE ANALYSIS
    // ============================================================
    if (/compare|vs|versus|against|difference|gap|best|worst|top|bottom/.test(lower)) {
      return this._handleComparativeQuery(trimmed);
    }

    // ============================================================
    // PRODUCTION ANALYSIS
    // ============================================================
    if (/production|output|units|make|manufacture|produce/.test(lower)) {
      return this._handleProductionQuery(trimmed);
    }

    // ============================================================
    // QUALITY ANALYSIS
    // ============================================================
    if (/quality|defect|reject|failure|inspection|non-conformance/.test(lower)) {
      return this._handleQualityQuery(trimmed);
    }

    // ============================================================
    // DOWNTIME ANALYSIS
    // ============================================================
    if (/downtime|stoppage|down|idle|breakdown|stop/.test(lower)) {
      return this._handleDowntimeQuery(trimmed);
    }

    // ============================================================
    // MANAGEMENT SUMMARY
    // ============================================================
    if (/summary|overview|dashboard|report|intelligence|management/.test(lower)) {
      return this._handleManagementSummary();
    }

    // ============================================================
    // ACTION RECOMMENDATIONS
    // ============================================================
    if (/action|recommend|suggest|improve|optimize|fix|solve/.test(lower)) {
      return this._handleActionRecommendations();
    }

    // ============================================================
    // DEFAULT FALLBACK
    // ============================================================
    return this._getHelpResponse();
  }

  // ============================================================
  // MANPOWER QUERY HANDLER
  // ============================================================
  _handleManpowerQuery(query) {
    const date = this.context.getTodayKey();
    const machine = this._extractMachine(query);
    const data = this.analytics.analyzeManpower(date, machine);

    let html = `<strong>👷 Manpower Control Analysis — ${date}</strong><br><br>`;

    // Summary cards
    html += `
      <div class="factory-ai-kpi-grid" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:14px;">
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">Total Operators</div>
          <div class="factory-ai-kpi-value">${data.totalOperators}</div>
        </div>
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">Coverage Rate</div>
          <div class="factory-ai-kpi-value" style="color:${data.coverageRate > 90 ? 'var(--ok)' : data.coverageRate > 75 ? 'var(--warn)' : 'var(--err)'}">
            ${data.coverageRate.toFixed(1)}%
          </div>
          <div class="factory-ai-kpi-sub">${data.utilizationScore}</div>
        </div>
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">Unassigned Prod.</div>
          <div class="factory-ai-kpi-value" style="color:${data.unassignedProduction > 0 ? 'var(--err)' : 'var(--ok)'}">
            ${qty(data.unassignedProduction)}
          </div>
          <div class="factory-ai-kpi-sub">${data.totalProduction > 0 ? ((data.unassignedProduction / data.totalProduction) * 100).toFixed(1) + '% of total' : '—'}</div>
        </div>
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">Avg Shift Duration</div>
          <div class="factory-ai-kpi-value">${data.avgShiftDuration.toFixed(1)} min</div>
        </div>
      </div>
    `;

    // Shift coverage
    html += `
      <div class="factory-ai-section-title">🕐 Shift Coverage</div>
      <div class="factory-ai-kpi-grid" style="grid-template-columns:repeat(2,minmax(0,1fr));margin-bottom:14px;">
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">A Shift</div>
          <div class="factory-ai-kpi-value">${data.shiftCoverage.A.count} operators</div>
          <div class="factory-ai-kpi-sub">${qty(data.shiftCoverage.A.production)} units</div>
        </div>
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">B Shift</div>
          <div class="factory-ai-kpi-value">${data.shiftCoverage.B.count} operators</div>
          <div class="factory-ai-kpi-sub">${qty(data.shiftCoverage.B.production)} units</div>
        </div>
      </div>
    `;

    // Shift balance
    if (data.shiftBalance > 0.15) {
      const better = data.shiftCoverage.A.production > data.shiftCoverage.B.production ? 'A' : 'B';
      html += `
        <div class="factory-ai-insight medium" style="margin-bottom:12px;">
          <div class="factory-ai-insight-head">
            <span class="factory-ai-dot"></span>
            <strong>⚠️ Shift Imbalance</strong>
            <span class="factory-ai-priority">${(data.shiftBalance * 100).toFixed(1)}% difference</span>
          </div>
          <div class="factory-ai-insight-text">${better} Shift is outperforming by ${(data.shiftBalance * 100).toFixed(1)}%. Consider balancing operators or investigating the lower-performing shift.</div>
        </div>
      `;
    }

    // Operator table
    if (data.operators.length) {
      html += `
        <table class="factory-ai-table">
          <thead><tr>
            <th>Operator</th>
            <th>Production</th>
            <th>Sessions</th>
            <th>Machines</th>
            <th>Status</th>
          </tr></thead>
          <tbody>
            ${data.operators.map(op => `
              <tr>
                <td>${esc(op.name)}</td>
                <td><strong>${qty(op.production)}</strong></td>
                <td>${op.sessions}</td>
                <td>${[...op.machines].join(', ')}</td>
                <td>${op.active ? '🟢 Active' : '✅ Done'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    }

    // Recommendations
    const recs = [];
    if (data.coverageRate < 80) {
      recs.push('🔴 Low coverage rate - ensure all operators are properly clocked in');
    }
    if (data.unassignedProduction > 100) {
      recs.push('🔴 High unassigned production - review session allocation and event timestamps');
    }
    if (data.totalOperators < 2) {
      recs.push('⚠️ Only 1 operator on duty - consider additional staffing');
    }
    if (data.shiftBalance > 0.2) {
      recs.push('⚠️ Significant shift imbalance - review shift schedules and workload distribution');
    }

    if (recs.length) {
      html += `<div class="factory-ai-muted" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line);">
        <strong>💡 Recommendations:</strong><br>
        ${recs.join('<br>')}
      </div>`;
    }

    return html;
  }

  // ============================================================
  // SCRAP QUERY HANDLER
  // ============================================================
  _handleScrapQuery(query) {
    const date = this.context.getTodayKey();
    const machine = this._extractMachine(query);
    const data = this.analytics.analyzeScrap(date, machine);

    let html = `<strong>♻️ Scrap Control Analysis — ${date}</strong><br><br>`;

    // Summary cards
    const severityColor = data.severity === 'Critical' ? 'var(--err)' : 
                          data.severity === 'High' ? 'var(--warn)' : 
                          data.severity === 'Medium' ? 'var(--text-dim)' : 'var(--ok)';

    html += `
      <div class="factory-ai-kpi-grid" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:14px;">
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">Total Scrap</div>
          <div class="factory-ai-kpi-value" style="color:${data.overallScrapRate > 5 ? 'var(--err)' : 'var(--ok)'}">
            ${qty(data.totalScrap)}
          </div>
        </div>
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">Scrap Rate</div>
          <div class="factory-ai-kpi-value" style="color:${severityColor}">
            ${data.overallScrapRate.toFixed(1)}%
          </div>
          <div class="factory-ai-kpi-sub">${data.severity}</div>
        </div>
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">Total Production</div>
          <div class="factory-ai-kpi-value">${qty(data.totalProduction)}</div>
        </div>
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">Scrap Cost</div>
          <div class="factory-ai-kpi-value" style="color:${data.scrapCost > 50 ? 'var(--err)' : 'var(--ok)'}">
            $${data.scrapCost.toFixed(2)}
          </div>
          <div class="factory-ai-kpi-sub">Estimated cost</div>
        </div>
      </div>
    `;

    // Scrap by machine
    if (data.machines.length > 1) {
      html += `
        <table class="factory-ai-table">
          <thead><tr>
            <th>Machine</th>
            <th>Production</th>
            <th>Scrap</th>
            <th>Rate</th>
            <th>Status</th>
          </tr></thead>
          <tbody>
            ${data.machines.sort((a, b) => b.rate - a.rate).map(m => `
              <tr>
                <td>${esc(m.machine)}</td>
                <td>${qty(m.production)}</td>
                <td style="color:${m.rate > 5 ? 'var(--err)' : 'var(--ok)'}">${qty(m.scrap)}</td>
                <td style="color:${m.rate > 5 ? 'var(--err)' : 'var(--ok)'}">${m.rate.toFixed(1)}%</td>
                <td>${m.rate > 5 ? '🔴 High' : m.rate > 3 ? '🟡 Medium' : '🟢 Low'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    }

    // Top scrap reasons
    if (data.topReasons.length) {
      html += `
        <div class="factory-ai-section-title">📋 Top Scrap Reasons</div>
        ${data.topReasons.map(([reason, qty]) => `
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line);">
            <span>${esc(reason)}</span>
            <span style="font-weight:700;">${qty} units (${((qty / data.totalScrap) * 100).toFixed(1)}%)</span>
          </div>
        `).join('')}
      `;
    }

    // Scrap by operator
    if (data.topOperators.length) {
      html += `
        <div class="factory-ai-section-title">👷 Scrap by Operator</div>
        ${data.topOperators.map(([op, qty]) => `
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line);">
            <span>${esc(this.context.operatorNames?.[op] || op)}</span>
            <span style="font-weight:700;">${qty} units</span>
          </div>
        `).join('')}
      `;
    }

    // Scrap hotspots
    if (data.hotspots.length) {
      html += `
        <div class="factory-ai-section-title">🔥 Scrap Hotspots</div>
        ${data.hotspots.map(m => `
          <div class="factory-ai-insight high" style="margin-bottom:8px;">
            <div class="factory-ai-insight-head">
              <span class="factory-ai-dot"></span>
              <strong>${esc(m.machine)}</strong>
              <span class="factory-ai-priority">${m.rate.toFixed(1)}% scrap rate</span>
            </div>
            <div class="factory-ai-insight-text">${qty(m.scrap)} scrap units out of ${qty(m.production)} produced</div>
          </div>
        `).join('')}
      `;
    }

    // Recommendations
    const recs = [];
    if (data.overallScrapRate > 5) {
      recs.push('🔴 High scrap rate - immediate investigation needed');
    }
    if (data.topReasons.length && data.topReasons[0][1] > data.totalScrap * 0.4) {
      recs.push(`🔴 ${data.topReasons[0][0]} accounts for ${((data.topReasons[0][1] / data.totalScrap) * 100).toFixed(1)}% of scrap - focus on this issue`);
    }
    if (data.hotspots.length) {
      recs.push(`⚠️ ${data.hotspots.length} machine(s) have >5% scrap rate - prioritize these`);
    }
    if (data.topOperators.length && data.topOperators[0][1] > data.totalScrap * 0.3) {
      recs.push(`⚠️ ${this.context.operatorNames?.[data.topOperators[0][0]] || data.topOperators[0][0]} has high scrap - provide additional training`);
    }

    if (recs.length) {
      html += `<div class="factory-ai-muted" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line);">
        <strong>💡 Recommendations:</strong><br>
        ${recs.join('<br>')}
      </div>`;
    }

    return html;
  }

  // ============================================================
  // ROOT CAUSE QUERY HANDLER
  // ============================================================
  _handleRootCauseQuery(query) {
    const date = this.context.getTodayKey();
    const machine = this._extractMachine(query);
    const targetMachine = machine || (this.context.constants.machines?.[0] || 'Unknown');

    const data = this.analytics.findRootCauses(targetMachine, date);

    let html = `<strong>🔍 Root Cause Analysis — ${targetMachine}</strong><br><br>`;

    // Summary
    const severityColor = data.severity === 'High' ? 'var(--err)' : 
                          data.severity === 'Medium' ? 'var(--warn)' : 'var(--ok)';

    html += `
      <div class="factory-ai-kpi-grid" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:14px;">
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">Production</div>
          <div class="factory-ai-kpi-value">${qty(data.production)} units</div>
        </div>
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">Issues Found</div>
          <div class="factory-ai-kpi-value">${data.causes.length}</div>
        </div>
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">Severity</div>
          <div class="factory-ai-kpi-value" style="color:${severityColor}">${data.severity}</div>
        </div>
      </div>
    `;

    // Detailed causes
    if (data.causes.length) {
      html += `<div class="factory-ai-section-title">📋 Detailed Findings</div>`;
      data.causes.forEach((cause, i) => {
        const level = cause.severity === 'High' ? 'high' : cause.severity === 'Medium' ? 'medium' : 'good';
        html += `
          <div class="factory-ai-insight ${level}" style="margin-bottom:8px;">
            <div class="factory-ai-insight-head">
              <span class="factory-ai-dot"></span>
              <strong>${i + 1}. ${cause.type.toUpperCase()}</strong>
              <span class="factory-ai-priority">${cause.severity}</span>
            </div>
            <div class="factory-ai-insight-text">${cause.description}</div>
            <div class="factory-ai-action">💡 Impact: ${cause.impact}</div>
          </div>
        `;
      });

      // Priority action items
      const highPriority = data.causes.filter(c => c.severity === 'High');
      if (highPriority.length) {
        html += `<div class="factory-ai-section-title">🚨 Priority Actions</div>`;
        highPriority.forEach(cause => {
          const actions = {
            downtime: '🔧 1. Investigate and resolve the primary downtime reason\n   2. Implement preventative maintenance',
            speed: '⚡ 1. Check machine calibration\n   2. Verify ideal speed setting\n   3. Review operator training',
            quality: '✅ 1. Inspect the defect pattern\n   2. Check raw materials\n   3. Review quality control procedures',
            manpower: '👷 1. Verify shift scheduling\n   2. Ensure proper session registration\n   3. Check attendance',
            idle: '⏱️ 1. Identify idle patterns\n   2. Review workflow\n   3. Improve scheduling'
          };
          const action = actions[cause.type] || '📋 Review and address the issue';
          html += `
            <div style="padding:8px 0;border-bottom:1px solid var(--line);font-size:12px;white-space:pre-line;color:var(--text);">
              ${action}
            </div>
          `;
        });
      }
    } else {
      html += `<div class="factory-ai-insight good">
        <div class="factory-ai-insight-head">
          <span class="factory-ai-dot"></span>
          <strong>✅ No Major Issues Found</strong>
        </div>
        <div class="factory-ai-insight-text">${targetMachine} is operating within normal parameters. Continue monitoring.</div>
      </div>`;
    }

    // Follow-up suggestions
    if (data.causes.length) {
      html += `<div class="factory-ai-muted" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line);">
        <strong>💡 Try asking:</strong><br>
        • "What's the scrap rate on ${targetMachine}?"<br>
        • "Show me the downtime breakdown for ${targetMachine}"<br>
        • "Who is the operator on ${targetMachine}?"<br>
        • "How does ${targetMachine} compare to others?"
      </div>`;
    }

    return html;
  }

  // ============================================================
  // FORECAST QUERY HANDLER
  // ============================================================
  _handleForecastQuery(query) {
    const date = this.context.getTodayKey();
    const machine = this._extractMachine(query) || (this.context.constants.machines?.[0] || 'Unknown');
    const days = this._extractNumber(query) || 7;

    const data = this.analytics.predictProduction(machine, Math.min(days, 30));

    let html = `<strong>🔮 Production Forecast — ${esc(machine)}</strong><br><br>`;

    // Summary
    const trendIcon = data.trendDirection === 'Increasing' ? '📈' : 
                      data.trendDirection === 'Decreasing' ? '📉' : '📊';
    const trendColor = data.trendDirection === 'Increasing' ? 'var(--ok)' : 
                       data.trendDirection === 'Decreasing' ? 'var(--err)' : 'var(--text-dim)';

    html += `
      <div class="factory-ai-kpi-grid" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:14px;">
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">30-Day Average</div>
          <div class="factory-ai-kpi-value">${qty(data.average)}</div>
        </div>
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">Trend</div>
          <div class="factory-ai-kpi-value" style="color:${trendColor}">${trendIcon} ${data.trendDirection}</div>
        </div>
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">Confidence</div>
          <div class="factory-ai-kpi-value" style="color:${data.confidence > 70 ? 'var(--ok)' : 'var(--warn)'}">
            ${data.confidence.toFixed(1)}%
          </div>
        </div>
      </div>
    `;

    // Forecast table
    if (data.forecast.length) {
      html += `
        <div class="factory-ai-section-title">📅 ${days}-Day Forecast</div>
        <table class="factory-ai-table">
          <thead><tr>
            <th>Date</th>
            <th>Predicted</th>
            <th>Lower Bound</th>
            <th>Upper Bound</th>
          </tr></thead>
          <tbody>
            ${data.forecast.map(f => `
              <tr>
                <td>${f.date}</td>
                <td><strong>${qty(f.predicted)}</strong></td>
                <td style="color:var(--text-dim)">${qty(f.lower)}</td>
                <td style="color:var(--text-dim)">${qty(f.upper)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;

      // Total forecast
      const totalForecast = data.forecast.reduce((a, f) => a + f.predicted, 0);
      html += `
        <div class="factory-ai-muted" style="margin-top:10px;">
          <strong>Total forecast for ${days} days:</strong> ${qty(totalForecast)} units
          ${data.trendDirection === 'Increasing' ? '📈 (upward trend)' : data.trendDirection === 'Decreasing' ? '📉 (downward trend)' : ''}
        </div>
      `;
    }

    // Historical summary
    html += `
      <div class="factory-ai-muted" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line);">
        <strong>📊 Recent History (last 7 days):</strong><br>
        ${data.historical.slice(-7).map(d => `${d.date}: ${qty(d.production)} units`).join(' · ')}
      </div>
    `;

    return html;
  }

  // ============================================================
  // TECHNICAL PERFORMANCE QUERY HANDLER
  // ============================================================
  _handleTechnicalQuery(query) {
    const date = this.context.getTodayKey();
    const machine = this._extractMachine(query);
    const data = this.analytics.analyzeTechnicalPerformance(date, machine);

    let html = `<strong>⚙️ Technical Performance — ${date}</strong><br><br>`;

    // Show each machine's detailed performance
    data.forEach(m => {
      const oeeColor = m.oee != null && m.oee > 0.6 ? 'var(--ok)' : 
                       m.oee != null && m.oee > 0.4 ? 'var(--warn)' : 'var(--err)';

      html += `
        <div class="factory-ai-insight" style="margin-bottom:12px;border-left-color:${oeeColor};">
          <div class="factory-ai-insight-head">
            <span class="factory-ai-dot"></span>
            <strong>${esc(m.machine)}</strong>
            <span class="factory-ai-priority">OEE: ${m.oee != null ? (m.oee * 100).toFixed(1) + '%' : '—'}</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:8px;">
            <div>
              <div style="font-size:10px;color:var(--text-dim);">Speed</div>
              <div style="font-size:14px;font-weight:700;">${m.avgSpeed.toFixed(1)} u/min</div>
              <div style="font-size:10px;color:var(--text-dim);">${m.speedSamples} samples</div>
            </div>
            <div>
              <div style="font-size:10px;color:var(--text-dim);">Availability</div>
              <div style="font-size:14px;font-weight:700;color:${m.availability > 0.9 ? 'var(--ok)' : 'var(--warn)'}">
                ${(m.availability * 100).toFixed(1)}%
              </div>
              <div style="font-size:10px;color:var(--text-dim);">${qty(m.downtimeMinutes)} min downtime</div>
            </div>
            <div>
              <div style="font-size:10px;color:var(--text-dim);">Quality</div>
              <div style="font-size:14px;font-weight:700;color:${m.quality != null && m.quality > 0.95 ? 'var(--ok)' : 'var(--warn)'}">
                ${m.quality != null ? (m.quality * 100).toFixed(1) + '%' : '—'}
              </div>
              <div style="font-size:10px;color:var(--text-dim);">${m.defectCount} defects</div>
            </div>
            <div>
              <div style="font-size:10px;color:var(--text-dim);">Consistency</div>
              <div style="font-size:14px;font-weight:700;color:${m.speedConsistency < 0.15 ? 'var(--ok)' : 'var(--warn)'}">
                ${(1 - m.speedConsistency) * 100 > 85 ? '✅ Stable' : '⚠️ Variable'}
              </div>
              <div style="font-size:10px;color:var(--text-dim);">CV: ${(m.speedConsistency * 100).toFixed(1)}%</div>
            </div>
          </div>
        </div>
      `;
    });

    // Recommendations
    const recs = [];
    data.forEach(m => {
      if (m.availability < 0.85) {
        recs.push(`🔴 ${m.machine}: Low availability (${(m.availability * 100).toFixed(1)}%) - review downtime`);
      }
      if (m.quality != null && m.quality < 0.9) {
        recs.push(`🔴 ${m.machine}: Quality issues (${(m.quality * 100).toFixed(1)}%) - investigate defects`);
      }
      if (m.speedConsistency > 0.2) {
        recs.push(`⚠️ ${m.machine}: Speed variation (${(m.speedConsistency * 100).toFixed(1)}%) - check for machine instability`);
      }
    });

    if (recs.length) {
      html += `<div class="factory-ai-muted" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line);">
        <strong>💡 Recommendations:</strong><br>
        ${recs.join('<br>')}
      </div>`;
    }

    return html;
  }

  // ============================================================
  // COMPARATIVE QUERY HANDLER
  // ============================================================
  _handleComparativeQuery(query) {
    const date = this.context.getTodayKey();
    const machines = this.context.constants.machines || [];
    
    if (machines.length < 2) {
      return 'Need at least 2 machines to perform a comparison.';
    }

    // Get all data
    const productionData = machines.map(id => {
      const d = this.context.overviewData[id] || {};
      const events = Object.values(d.events || {});
      const today = events.filter(e => this.context.dateKeyFor(e.timestamp) === date);
      const actual = today.reduce((a, e) => a + num(e.count), 0);
      const status = this.context.getMachineStatus(id);
      const scrap = this.context.scrapForMachineDate(id, date);
      const downtime = this.analytics._getDowntimeForMachine(id, date);
      const downtimeMinutes = downtime.reduce((a, r) => a + num(r.durationMinutes), 0);
      const defects = this.analytics._getQualityForMachine(id, date);
      return { id, actual, status, scrap, downtimeMinutes, defects: defects.length };
    });

    productionData.sort((a, b) => b.actual - a.actual);

    let html = `<strong>📊 Comparative Analysis — ${date}</strong><br><br>`;

    // Best and worst
    const best = productionData[0];
    const worst = productionData[productionData.length - 1];

    html += `
      <div class="factory-ai-kpi-grid" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:14px;">
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">🏆 Best</div>
          <div class="factory-ai-kpi-value" style="color:var(--ok)">${esc(best.id)}</div>
          <div class="factory-ai-kpi-sub">${qty(best.actual)} units</div>
        </div>
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">📊 Gap</div>
          <div class="factory-ai-kpi-value">${best.actual > 0 ? ((best.actual - worst.actual) / best.actual * 100).toFixed(1) + '%' : '—'}</div>
          <div class="factory-ai-kpi-sub">Best vs Worst</div>
        </div>
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">⚠️ Worst</div>
          <div class="factory-ai-kpi-value" style="color:var(--err)">${esc(worst.id)}</div>
          <div class="factory-ai-kpi-sub">${qty(worst.actual)} units</div>
        </div>
      </div>
    `;

    // Full comparison table
    html += `
      <table class="factory-ai-table">
        <thead><tr>
          <th>Machine</th>
          <th>Production</th>
          <th>Status</th>
          <th>Downtime</th>
          <th>Scrap</th>
          <th>Defects</th>
          <th>Performance</th>
        </tr></thead>
        <tbody>
          ${productionData.map((d, i) => {
            const rank = i + 1;
            const rankLabel = rank === 1 ? '⭐' : rank === productionData.length ? '⚠️' : '';
            const perf = d.actual / productionData[0].actual * 100;
            return `
              <tr>
                <td>${esc(d.id)} ${rankLabel}</td>
                <td><strong>${qty(d.actual)}</strong></td>
                <td>${esc(d.status.label)}</td>
                <td style="color:${d.downtimeMinutes > 60 ? 'var(--err)' : 'var(--text-dim)'}">${qty(d.downtimeMinutes)} min</td>
                <td style="color:${d.scrap > 10 ? 'var(--err)' : 'var(--text-dim)'}">${qty(d.scrap)}</td>
                <td style="color:${d.defects > 5 ? 'var(--err)' : 'var(--text-dim)'}">${d.defects}</td>
                <td style="color:${perf > 80 ? 'var(--ok)' : perf > 50 ? 'var(--warn)' : 'var(--err)'}">
                  ${perf.toFixed(1)}% of best
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;

    // Insights
    const bestScrap = productionData.reduce((a, b) => a.scrap < b.scrap ? a : b);
    const worstScrap = productionData.reduce((a, b) => a.scrap > b.scrap ? a : b);
    
    html += `
      <div class="factory-ai-muted" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line);">
        <strong>💡 Insights:</strong><br>
        • Best production: ${esc(best.id)} (${qty(best.actual)} units)<br>
        • Lowest scrap: ${esc(bestScrap.id)} (${qty(bestScrap.scrap)} units)<br>
        • Highest scrap: ${esc(worstScrap.id)} (${qty(worstScrap.scrap)} units) ${worstScrap.scrap > 10 ? '⚠️' : ''}<br>
        • ${productionData.filter(d => d.status.label !== 'Running').length} machine(s) not running
      </div>
    `;

    return html;
  }

  // ============================================================
  // PRODUCTION QUERY HANDLER
  // ============================================================
  _handleProductionQuery(query) {
    const date = this.context.getTodayKey();
    const machine = this._extractMachine(query);
    const machines = machine ? [machine] : this.context.constants.machines || [];
    
    let total = 0;
    const data = [];
    machines.forEach(id => {
      const d = this.context.overviewData[id] || {};
      const events = Object.values(d.events || {});
      const today = events.filter(e => this.context.dateKeyFor(e.timestamp) === date);
      const actual = today.reduce((a, e) => a + num(e.count), 0);
      total += actual;
      data.push({ id, actual });
    });

    let html = `<strong>📊 Production Summary — ${date}</strong><br><br>`;

    // Quick glance
    const isBest = /\bbest\b/.test(query) || /\btop\b/.test(query);
    const isWorst = /\bworst\b/.test(query) || /\blow\b/.test(query);

    if (isBest && data.length) {
      const best = data.reduce((a, b) => a.actual > b.actual ? a : b);
      html += `🏆 Best machine: <strong style="color:var(--ok);">${esc(best.id)}</strong> with <strong>${qty(best.actual)}</strong> units<br><br>`;
      html += `<strong>Full ranking:</strong><br>`;
      data.sort((a, b) => b.actual - a.actual).forEach((d, i) => {
        html += `${i + 1}. ${esc(d.id)} — ${qty(d.actual)} units${i === 0 ? ' ⭐' : ''}<br>`;
      });
      return html;
    }

    if (isWorst && data.length) {
      const worst = data.filter(d => d.actual > 0).reduce((a, b) => a.actual < b.actual ? a : b, { actual: Infinity });
      if (worst.actual === Infinity) return 'No production recorded today.';
      html += `⚠️ Lowest performing: <strong style="color:var(--err);">${esc(worst.id)}</strong> with <strong>${qty(worst.actual)}</strong> units<br><br>`;
      data.sort((a, b) => a.actual - b.actual).forEach((d, i) => {
        html += `${i + 1}. ${esc(d.id)} — ${qty(d.actual)} units${d.actual === worst.actual ? ' ⚠️' : ''}<br>`;
      });
      return html;
    }

    // Standard production view
    html += `
      <div class="factory-ai-kpi-grid" style="grid-template-columns:repeat(2,minmax(0,1fr));margin-bottom:14px;">
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">Total Production</div>
          <div class="factory-ai-kpi-value">${qty(total)}</div>
        </div>
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">Active Machines</div>
          <div class="factory-ai-kpi-value">${data.filter(d => d.actual > 0).length} / ${data.length}</div>
        </div>
      </div>
    `;

    html += `
      <table class="factory-ai-table">
        <thead><tr>
          <th>Machine</th>
          <th>Production</th>
          <th>% of Total</th>
        </tr></thead>
        <tbody>
          ${data.sort((a, b) => b.actual - a.actual).map(d => `
            <tr>
              <td>${esc(d.id)}</td>
              <td><strong>${qty(d.actual)}</strong></td>
              <td>${total > 0 ? ((d.actual / total) * 100).toFixed(1) + '%' : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    return html;
  }

  // ============================================================
  // QUALITY QUERY HANDLER
  // ============================================================
  _handleQualityQuery(query) {
    const date = this.context.getTodayKey();
    const machine = this._extractMachine(query);
    const data = this.analytics.analyzeScrap(date, machine);

    let html = `<strong>✅ Quality Analysis — ${date}</strong><br><br>`;

    // Summary cards
    html += `
      <div class="factory-ai-kpi-grid" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:14px;">
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">Defects</div>
          <div class="factory-ai-kpi-value" style="color:${data.topReasons.length > 3 ? 'var(--err)' : 'var(--ok)'}">
            ${data.topReasons.reduce((a, r) => a + r[1], 0)}
          </div>
        </div>
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">Scrap Rate</div>
          <div class="factory-ai-kpi-value" style="color:${data.overallScrapRate > 5 ? 'var(--err)' : 'var(--ok)'}">
            ${data.overallScrapRate.toFixed(1)}%
          </div>
        </div>
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">Top Issue</div>
          <div class="factory-ai-kpi-value" style="font-size:16px;">
            ${data.topReasons.length ? esc(data.topReasons[0][0]) : 'None'}
          </div>
        </div>
      </div>
    `;

    // Quality breakdown
    if (data.topReasons.length) {
      html += `
        <div class="factory-ai-section-title">📋 Defect Breakdown</div>
        ${data.topReasons.map(([type, qty]) => `
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line);">
            <span>${esc(type)}</span>
            <span style="font-weight:700;">${qty} units (${((qty / data.totalScrap) * 100).toFixed(1)}%)</span>
          </div>
        `).join('')}
      `;
    }

    // Recommendations
    if (data.overallScrapRate > 5) {
      html += `
        <div class="factory-ai-insight high" style="margin-top:12px;">
          <div class="factory-ai-insight-head">
            <span class="factory-ai-dot"></span>
            <strong>⚠️ Quality Alert</strong>
            <span class="factory-ai-priority">${data.overallScrapRate.toFixed(1)}% scrap rate</span>
          </div>
          <div class="factory-ai-insight-text">
            Scrap rate exceeds the 5% threshold. 
            ${data.topReasons.length ? `Focus on "${data.topReasons[0][0]}" which accounts for ${((data.topReasons[0][1] / data.totalScrap) * 100).toFixed(1)}% of scrap.` : ''}
          </div>
          <div class="factory-ai-action">💡 Action: Review quality control procedures and inspect ${data.topReasons.length ? data.topReasons[0][0] : 'defect'} patterns.</div>
        </div>
      `;
    }

    return html;
  }

  // ============================================================
  // DOWNTIME QUERY HANDLER
  // ============================================================
  _handleDowntimeQuery(query) {
    const date = this.context.getTodayKey();
    const machine = this._extractMachine(query);
    const machines = machine ? [machine] : this.context.constants.machines || [];
    
    let totalDowntime = 0;
    const details = [];
    const allReasons = {};

    machines.forEach(id => {
      const records = this.analytics._getDowntimeForMachine(id, date);
      const minutes = records.reduce((a, r) => a + num(r.durationMinutes), 0);
      totalDowntime += minutes;
      details.push({ id, minutes, records });
      records.forEach(r => {
        const reason = r.reason || 'Unspecified';
        allReasons[reason] = (allReasons[reason] || 0) + num(r.durationMinutes);
      });
    });

    let html = `<strong>⏱️ Downtime Analysis — ${date}</strong><br><br>`;

    html += `
      <div class="factory-ai-kpi-grid" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:14px;">
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">Total Downtime</div>
          <div class="factory-ai-kpi-value" style="color:${totalDowntime > 120 ? 'var(--err)' : 'var(--ok)'}">
            ${qty(totalDowntime)} min
          </div>
        </div>
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">Incidents</div>
          <div class="factory-ai-kpi-value">${details.reduce((a, d) => a + d.records.length, 0)}</div>
        </div>
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">Top Reason</div>
          <div class="factory-ai-kpi-value" style="font-size:16px;">
            ${Object.entries(allReasons).sort((a, b) => b[1] - a[1])[0]?.[0] || 'None'}
          </div>
        </div>
      </div>
    `;

    // Machine breakdown
    html += `
      <table class="factory-ai-table">
        <thead><tr>
          <th>Machine</th>
          <th>Downtime</th>
          <th>Incidents</th>
          <th>Top Reason</th>
          <th>Status</th>
        </tr></thead>
        <tbody>
          ${details.sort((a, b) => b.minutes - a.minutes).map(d => {
            const top = d.records.reduce((a, r) => {
              const reason = r.reason || 'Unspecified';
              const minutes = num(r.durationMinutes);
              return minutes > a.minutes ? { reason, minutes } : a;
            }, { reason: '—', minutes: 0 });
            return `
              <tr>
                <td>${esc(d.id)}</td>
                <td style="color:${d.minutes > 60 ? 'var(--err)' : 'var(--text-dim)'}">${qty(d.minutes)} min</td>
                <td>${d.records.length}</td>
                <td>${top.minutes > 0 ? esc(top.reason) : '—'}</td>
                <td>${d.minutes > 60 ? '⚠️ High' : d.minutes > 30 ? '🟡 Medium' : '🟢 Low'}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;

    // Recommendations
    const topReason = Object.entries(allReasons).sort((a, b) => b[1] - a[1])[0];
    if (totalDowntime > 120 && topReason) {
      html += `
        <div class="factory-ai-insight high" style="margin-top:12px;">
          <div class="factory-ai-insight-head">
            <span class="factory-ai-dot"></span>
            <strong>⚠️ High Downtime Alert</strong>
            <span class="factory-ai-priority">${qty(totalDowntime)} min</span>
          </div>
          <div class="factory-ai-insight-text">
            ${topReason[0]} accounts for ${((topReason[1] / totalDowntime) * 100).toFixed(1)}% of downtime (${qty(topReason[1])} min).
          </div>
          <div class="factory-ai-action">💡 Action: Investigate ${topReason[0]} patterns and implement corrective measures.</div>
        </div>
      `;
    }

    return html;
  }

  // ============================================================
  // MANAGEMENT SUMMARY
  // ============================================================
  _handleManagementSummary() {
    const date = this.context.getTodayKey();
    const machines = this.context.constants.machines || [];
    
    // Get all key metrics
    const manpower = this.analytics.analyzeManpower(date);
    const scrap = this.analytics.analyzeScrap(date);
    const technical = this.analytics.analyzeTechnicalPerformance(date);

    let html = `
      <div class="factory-ai-management">
        <div class="factory-ai-section-title">
          📊 Executive Dashboard — ${date}
          <span style="font-weight:400;color:var(--text-dim);font-size:11px;margin-left:10px;">
            ${new Date().toLocaleTimeString()}
          </span>
        </div>
    `;

    // KPI Grid
    const totalProduction = technical.reduce((a, m) => a + m.production, 0);
    const avgOEE = technical.filter(m => m.oee != null).reduce((a, m) => a + m.oee, 0) / 
                   (technical.filter(m => m.oee != null).length || 1);
    const totalDowntime = technical.reduce((a, m) => a + m.downtimeMinutes, 0);
    const totalScrap = scrap.totalScrap;

    html += `
      <div class="factory-ai-kpi-grid factory-ai-management-kpis">
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">📦 Production</div>
          <div class="factory-ai-kpi-value">${qty(totalProduction)}</div>
          <div class="factory-ai-kpi-sub">${machines.length} machines</div>
        </div>
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">⚙️ OEE</div>
          <div class="factory-ai-kpi-value" style="color:${avgOEE > 0.6 ? 'var(--ok)' : 'var(--err)'}">
            ${(avgOEE * 100).toFixed(1)}%
          </div>
          <div class="factory-ai-kpi-sub">${avgOEE > 0.6 ? '✅ On track' : '⚠️ Needs attention'}</div>
        </div>
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">⏱️ Downtime</div>
          <div class="factory-ai-kpi-value" style="color:${totalDowntime > 120 ? 'var(--err)' : 'var(--ok)'}">
            ${qty(totalDowntime)} min
          </div>
          <div class="factory-ai-kpi-sub">${totalDowntime > 120 ? '⚠️ High' : 'Normal'}</div>
        </div>
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">♻️ Scrap</div>
          <div class="factory-ai-kpi-value" style="color:${scrap.overallScrapRate > 5 ? 'var(--err)' : 'var(--ok)'}">
            ${qty(totalScrap)}
          </div>
          <div class="factory-ai-kpi-sub">${scrap.overallScrapRate.toFixed(1)}% rate</div>
        </div>
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">👷 Manpower</div>
          <div class="factory-ai-kpi-value">${manpower.totalOperators}</div>
          <div class="factory-ai-kpi-sub">${manpower.coverageRate.toFixed(1)}% coverage</div>
        </div>
        <div class="factory-ai-kpi">
          <div class="factory-ai-kpi-label">🏆 Best Machine</div>
          <div class="factory-ai-kpi-value" style="font-size:16px;">
            ${technical.sort((a, b) => b.production - a.production)[0]?.machine || '—'}
          </div>
          <div class="factory-ai-kpi-sub">${qty(technical.sort((a, b) => b.production - a.production)[0]?.production || 0)} units</div>
        </div>
      </div>
    `;

    // Critical issues
    const criticalIssues = [];
    if (scrap.overallScrapRate > 5) {
      criticalIssues.push({
        severity: 'high',
        title: `High Scrap Rate: ${scrap.overallScrapRate.toFixed(1)}%`,
        detail: `${qty(scrap.totalScrap)} units scrapped today`,
        action: `Focus on ${scrap.topReasons[0]?.[0] || 'top defect'} reduction`
      });
    }
    if (totalDowntime > 120) {
      const topReason = Object.entries(
        technical.reduce((acc, m) => {
          const records = this.analytics._getDowntimeForMachine(m.machine, date);
          records.forEach(r => {
            const reason = r.reason || 'Unspecified';
            acc[reason] = (acc[reason] || 0) + num(r.durationMinutes);
          });
          return acc;
        }, {})
      ).sort((a, b) => b[1] - a[1])[0];
      criticalIssues.push({
        severity: 'high',
        title: `High Downtime: ${qty(totalDowntime)} min`,
        detail: topReason ? `${topReason[0]}: ${qty(topReason[1])} min` : 'Multiple reasons',
        action: `Address ${topReason ? topReason[0] : 'downtime'} issues immediately`
      });
    }
    if (manpower.coverageRate < 80) {
      criticalIssues.push({
        severity: 'medium',
        title: `Low Manpower Coverage: ${manpower.coverageRate.toFixed(1)}%`,
        detail: `${qty(manpower.unassignedProduction)} units unassigned`,
        action: 'Review shift schedules and session registration'
      });
    }
    const lowOEE = technical.filter(m => m.oee != null && m.oee < 0.5);
    if (lowOEE.length) {
      criticalIssues.push({
        severity: 'medium',
        title: `${lowOEE.length} Machine(s) with Low OEE (<50%)`,
        detail: lowOEE.map(m => `${m.machine}: ${(m.oee * 100).toFixed(1)}%`).join(' · '),
        action: 'Investigate availability, performance, and quality factors'
      });
    }

    if (criticalIssues.length) {
      html += `<div class="factory-ai-section-title factory-ai-section-title-gap">🚨 Critical Issues</div>`;
      criticalIssues.forEach(issue => {
        html += `
          <div class="factory-ai-insight ${issue.severity}">
            <div class="factory-ai-insight-head">
              <span class="factory-ai-dot"></span>
              <strong>${issue.title}</strong>
              <span class="factory-ai-priority">${issue.severity.toUpperCase()}</span>
            </div>
            <div class="factory-ai-insight-text">${issue.detail}</div>
            <div class="factory-ai-action">💡 Action: ${issue.action}</div>
          </div>
        `;
      });
    } else {
      html += `
        <div class="factory-ai-insight good" style="margin-top:12px;">
          <div class="factory-ai-insight-head">
            <span class="factory-ai-dot"></span>
            <strong>✅ All Systems Operating Normally</strong>
          </div>
          <div class="factory-ai-insight-text">No critical issues detected. Continue monitoring.</div>
        </div>
      `;
    }

    // Machine performance snapshot
    html += `
      <div class="factory-ai-section-title factory-ai-section-title-gap">🏭 Machine Performance</div>
      <table class="factory-ai-table">
        <thead><tr>
          <th>Machine</th>
          <th>Production</th>
          <th>Speed</th>
          <th>OEE</th>
          <th>Status</th>
        </tr></thead>
        <tbody>
          ${technical.sort((a, b) => b.production - a.production).map(m => `
            <tr>
              <td>${esc(m.machine)}</td>
              <td><strong>${qty(m.production)}</strong></td>
              <td>${m.avgSpeed.toFixed(1)} u/min</td>
              <td style="color:${m.oee != null && m.oee > 0.6 ? 'var(--ok)' : 'var(--warn)'}">
                ${m.oee != null ? (m.oee * 100).toFixed(1) + '%' : '—'}
              </td>
              <td>${m.downtimeMinutes > 60 ? '⚠️' : m.production > 0 ? '✅' : '⏸️'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    // Recommendations summary
    const recs = [];
    if (scrap.overallScrapRate > 5) recs.push('♻️ Reduce scrap through defect analysis and operator training');
    if (totalDowntime > 120) recs.push('⏱️ Implement preventative maintenance for high-downtime machines');
    if (manpower.coverageRate < 80) recs.push('👷 Optimize shift scheduling and ensure complete session registration');
    if (avgOEE < 0.6) recs.push('⚙️ Improve OEE by addressing availability, performance, and quality gaps');

    if (recs.length) {
      html += `
        <div class="factory-ai-section-title factory-ai-section-title-gap">💡 Recommended Actions</div>
        ${recs.map(r => `<div style="padding:6px 0;border-bottom:1px solid var(--line);font-size:13px;">• ${r}</div>`).join('')}
      `;
    }

    // Follow-up suggestions
    html += `
      <div class="factory-ai-muted" style="margin-top:14px;padding-top:14px;border-top:1px solid var(--line);">
        <strong>💡 Try asking:</strong><br>
        • "Show me the scrap breakdown"<br>
        • "Analyze manpower coverage"<br>
        • "Compare all machines"<br>
        • "What's the root cause for [machine]?"<br>
        • "Predict next week's production"
      </div>
    `;

    html += `</div>`;
    return html;
  }

  // ============================================================
  // ACTION RECOMMENDATIONS
  // ============================================================
  _handleActionRecommendations() {
    const date = this.context.getTodayKey();
    const machines = this.context.constants.machines || [];
    
    // Gather all insights
    const actions = [];
    
    // Scrap actions
    machines.forEach(id => {
      const scrapData = this.analytics.analyzeScrap(date, id);
      if (scrapData.overallScrapRate > 5) {
        actions.push({
          priority: scrapData.overallScrapRate > 8 ? 'High' : 'Medium',
          category: 'Scrap Reduction',
          machine: id,
          description: `${scrapData.overallScrapRate.toFixed(1)}% scrap rate (${qty(scrapData.totalScrap)} units)`,
          action: `Inspect ${id} for ${scrapData.topReasons[0]?.[0] || 'defect'} patterns and adjust process`
        });
      }
    });

    // Downtime actions
    machines.forEach(id => {
      const downtime = this.analytics._getDowntimeForMachine(id, date);
      const minutes = downtime.reduce((a, r) => a + num(r.durationMinutes), 0);
      if (minutes > 60) {
        const reasons = {};
        downtime.forEach(r => {
          const reason = r.reason || 'Unspecified';
          reasons[reason] = (reasons[reason] || 0) + num(r.durationMinutes);
        });
        const top = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0];
        actions.push({
          priority: minutes > 120 ? 'High' : 'Medium',
          category: 'Downtime Reduction',
          machine: id,
          description: `${qty(minutes)} min downtime, mainly "${top?.[0] || 'Unknown'}"`,
          action: `Implement corrective maintenance for ${top?.[0] || 'downtime'} on ${id}`
        });
      }
    });

    // Manpower actions
    const manpower = this.analytics.analyzeManpower(date);
    if (manpower.coverageRate < 80) {
      actions.push({
        priority: 'Medium',
        category: 'Manpower Optimization',
        machine: 'All',
        description: `${manpower.coverageRate.toFixed(1)}% coverage, ${qty(manpower.unassignedProduction)} unassigned`,
        action: 'Review shift schedules and ensure all operators are properly clocked in'
      });
    }

    // Sort by priority
    const priorityOrder = { High: 0, Medium: 1, Low: 2 };
    actions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    let html = `<strong>💡 Action Recommendations</strong><br><br>`;

    if (!actions.length) {
      html += `
        <div class="factory-ai-insight good">
          <div class="factory-ai-insight-head">
            <span class="factory-ai-dot"></span>
            <strong>✅ No Actions Required</strong>
          </div>
          <div class="factory-ai-insight-text">All systems are operating within acceptable parameters. Continue monitoring.</div>
        </div>
      `;
      return html;
    }

    actions.forEach((a, i) => {
      const level = a.priority === 'High' ? 'high' : a.priority === 'Medium' ? 'medium' : 'good';
      html += `
        <div class="factory-ai-insight ${level}" style="margin-bottom:10px;">
          <div class="factory-ai-insight-head">
            <span class="factory-ai-dot"></span>
            <strong>${i + 1}. ${a.category} — ${a.machine}</strong>
            <span class="factory-ai-priority">${a.priority}</span>
          </div>
          <div class="factory-ai-insight-text">${a.description}</div>
          <div class="factory-ai-action">🔧 ${a.action}</div>
          ${a.priority === 'High' ? `<div style="margin-top:6px;font-size:11px;color:var(--err);">⚠️ This should be addressed today</div>` : ''}
        </div>
      `;
    });

    return html;
  }

  // ============================================================
  // HELP RESPONSE
  // ============================================================
  _getHelpResponse() {
    return `
      <strong>🤖 Factory AI Assistant — Enhanced Edition</strong><br><br>
      <strong>What I can help you with:</strong><br><br>
      
      <strong>👷 Manpower Control</strong><br>
      • "Analyze manpower coverage today"<br>
      • "Show me shift staffing levels"<br>
      • "Who is the top performing operator?"<br>
      • "What's the utilization rate?"<br><br>
      
      <strong>♻️ Scrap Control</strong><br>
      • "What's the scrap rate today?"<br>
      • "Show me scrap by machine"<br>
      • "Which operator has the most scrap?"<br>
      • "What are the top scrap reasons?"<br><br>
      
      <strong>🔍 Root Cause Analysis</strong><br>
      • "Why is M01-A underperforming?"<br>
      • "Investigate downtime on M01-B"<br>
      • "Root cause for quality issues"<br><br>
      
      <strong>📈 Predictive Analytics</strong><br>
      • "Predict next week's production"<br>
      • "Forecast performance for M01-C"<br>
      • "When will we hit our target?"<br><br>
      
      <strong>⚙️ Technical Performance</strong><br>
      • "Show me OEE breakdown"<br>
      • "What's the speed consistency?"<br>
      • "Compare all machines technically"<br><br>
      
      <strong>📊 Management</strong><br>
      • "Give me a full management summary"<br>
      • "What should I focus on today?"<br>
      • "Show me action recommendations"<br><br>
      
      <strong>💡 Try asking:</strong><br>
      • "Analyze manpower coverage"<br>
      • "Show me scrap breakdown"<br>
      • "Root cause for M01-A"<br>
      • "Predict next week"<br>
      • "Action recommendations"
    `;
  }

  // ============================================================
  // HELPER METHODS
  // ============================================================
  
  _extractMachine(query) {
    const machines = this.context.constants.machines || [];
    const lower = query.toLowerCase();
    for (const m of machines) {
      if (lower.includes(m.toLowerCase())) return m;
    }
    // Partial match
    for (const m of machines) {
      const parts = m.split('-');
      for (const part of parts) {
        if (lower.includes(part.toLowerCase()) && part.length > 1) return m;
      }
    }
    return null;
  }

  _extractNumber(query) {
    const match = query.match(/\b(\d+)\s*(days?|weeks?|months?)/i);
    if (match) {
      const num = parseInt(match[1]);
      const unit = match[2].toLowerCase();
      if (unit.startsWith('week')) return num * 7;
      if (unit.startsWith('month')) return num * 30;
      return num;
    }
    const plainMatch = query.match(/\b(\d+)\b/);
    return plainMatch ? parseInt(plainMatch[1]) : null;
  }

  _addToMemory(role, content) {
    this.memory.push({ role, content, timestamp: Date.now() });
    if (this.memory.length > this.MAX_MEMORY) {
      this.memory.shift();
    }
  }
}

// ============================================================
// INITIALIZATION
// ============================================================
function init(context) {
  const engine = new EnhancedAIEngine(context);
  
  const input = document.getElementById('factoryAiInput');
  const btn = document.getElementById('factoryAiAskBtn');
  const chat = document.getElementById('factoryAiChat');
  const empty = document.getElementById('factoryAiEmpty');
  const auto = document.getElementById('factoryAiAuto');

  if (!input || !btn || !chat) return;

  function add(html, kind) {
    if (empty) empty.style.display = 'none';
    const row = document.createElement('div');
    row.className = 'factory-ai-msg ' + kind;
    const b = document.createElement('div');
    b.className = 'factory-ai-bubble';
    b.innerHTML = html;
    row.appendChild(b);
    chat.appendChild(row);
    chat.scrollTop = chat.scrollHeight;
  }

  function ask() {
    const q = input.value.trim();
    if (!q) return;
    add(esc(q), 'user');
    input.value = '';
    try {
      const response = engine.answer(q);
      add(response, 'ai');
      
      // Update suggestions to be more contextual
      const suggestions = document.querySelectorAll('[data-ai-q]');
      const contextSuggestions = [
        'Analyze manpower coverage',
        'Show me scrap breakdown',
        'Root cause for M01-A',
        'Action recommendations',
        'Compare all machines',
        'Predict next week',
        'What should I focus on today?'
      ];
      suggestions.forEach((btn, i) => {
        if (i < contextSuggestions.length) {
          btn.textContent = contextSuggestions[i];
          btn.dataset.aiQ = contextSuggestions[i];
        }
      });
    } catch (e) {
      console.error(e);
      add('<span class="factory-ai-error">I encountered an error. Please try a different question.</span>', 'ai');
    }
  }

  btn.addEventListener('click', ask);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') ask(); });

  // Suggestions with dynamic updates
  document.querySelectorAll('[data-ai-q]').forEach(b => {
    b.addEventListener('click', () => {
      input.value = b.dataset.aiQ || '';
      ask();
    });
  });

  // Auto-refresh management summary
  function refreshAuto() {
    if (auto) {
      try {
        auto.innerHTML = engine.answer('management summary');
      } catch (e) {
        auto.innerHTML = '<div class="factory-ai-error">Waiting for data…</div>';
      }
    }
  }

  refreshAuto();
  setInterval(refreshAuto, 30000);

  // Expose engine for debugging
  window.StressONFactoryAI = {
    ask,
    answer: q => engine.answer(q),
    refresh: refreshAuto,
    getInsights: () => engine.answer('action recommendations'),
    getContext: () => engine.memory.slice(-5)
  };
}

// Wait for context
function waitForContext() {
  if (window.StressONAIContext) {
    init(window.StressONAIContext);
    return;
  }
  setTimeout(waitForContext, 100);
}

waitForContext();

})();