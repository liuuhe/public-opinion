import type {
  AnalysisDiagnostics,
  AnalysisEngine,
  AnalysisInsight,
  AnalysisReport,
  AnalysisResponse,
  AnalysisTotals,
  CapturedPost,
  LabeledSample,
  SentimentBucket,
  SentimentLabel
} from "../src/shared/types";

const LABELS: SentimentLabel[] = ["positive", "neutral", "negative"];

export function buildDistribution(
  samples: LabeledSample[]
): Record<SentimentLabel, SentimentBucket> {
  const total = samples.length || 1;

  return LABELS.reduce(
    (accumulator, label) => {
      const matches = samples.filter((sample) => sample.label === label);
      const confidenceSum = matches.reduce((sum, sample) => sum + sample.confidence, 0);
      accumulator[label] = {
        label,
        count: matches.length,
        ratio: Number((matches.length / total).toFixed(4)),
        averageConfidence: matches.length
          ? Number((confidenceSum / matches.length).toFixed(4))
          : 0
      };
      return accumulator;
    },
    {} as Record<SentimentLabel, SentimentBucket>
  );
}

export function pickRepresentativeSamples(samples: LabeledSample[], perLabel = 4): LabeledSample[] {
  return LABELS.flatMap((label) =>
    samples
      .filter((sample) => sample.label === label)
      .sort((left, right) => right.confidence - left.confidence)
      .slice(0, perLabel)
  );
}

export function buildAnalysisResponse(input: {
  keyword: string;
  engine: AnalysisEngine;
  capturedAt: string;
  posts: CapturedPost[];
  labeledSamples: LabeledSample[];
  warnings: string[];
  diagnostics?: AnalysisDiagnostics;
  sourceMode?: "fixture" | "client";
}): AnalysisResponse {
  const distribution = buildDistribution(input.labeledSamples);
  const totals: AnalysisTotals = {
    posts: input.posts.length,
    comments: input.posts.reduce((sum, post) => sum + post.comments.length, 0),
    validSamples: input.labeledSamples.length
  };
  const sourceMode = input.sourceMode || "client";
  const summary = buildSummary({
    keyword: input.keyword,
    distribution,
    totals,
    diagnostics: input.diagnostics,
    sourceMode
  });
  const insights = buildInsights({
    distribution,
    totals,
    posts: input.posts,
    labeledSamples: input.labeledSamples
  });
  const report = buildReport({
    keyword: input.keyword,
    summary,
    insights,
    distribution,
    totals,
    warnings: input.warnings,
    diagnostics: input.diagnostics
  });

  return {
    keyword: input.keyword,
    engine: input.engine,
    capturedAt: input.capturedAt,
    totals,
    distribution,
    posts: input.posts,
    labeledSamples: input.labeledSamples,
    samples: pickRepresentativeSamples(input.labeledSamples),
    warnings: input.warnings,
    summary,
    insights,
    report,
    diagnostics: input.diagnostics,
    exports: buildExportInfo(input.keyword),
    sourceMode
  };
}

export function buildSummary(input: {
  keyword: string;
  distribution: Record<SentimentLabel, SentimentBucket>;
  totals: AnalysisTotals;
  diagnostics?: AnalysisDiagnostics;
  sourceMode: "fixture" | "client";
}): string {
  if (input.totals.validSamples === 0) {
    const advice = input.diagnostics?.advice || "建议检查登录态、关键词结果和页面结构后重试。";
    return `“${input.keyword}”暂未获得可分析评论样本。${advice}`;
  }

  const dominant = Object.values(input.distribution).sort((left, right) => right.count - left.count)[0];
  const labelName = {
    positive: "正向",
    neutral: "中性",
    negative: "负向"
  }[dominant.label];
  const sourceNote =
    input.sourceMode === "fixture"
      ? "当前为本地演示数据，"
      : "当前样本来自浏览器插件在已登录小红书页面采集，";
  return `${sourceNote}“${input.keyword}”共分析 ${input.totals.validSamples} 条评论，${labelName}情绪占比最高（${Math.round(
    dominant.ratio * 100
  )}%）。样本来自 ${input.totals.posts} 篇帖子，结论应结合抓取样本量和平台个性化推荐偏差解读。`;
}

function buildInsights(input: {
  distribution: Record<SentimentLabel, SentimentBucket>;
  totals: AnalysisTotals;
  posts: CapturedPost[];
  labeledSamples: LabeledSample[];
}): AnalysisInsight[] {
  if (input.totals.validSamples === 0) {
    return [
      {
        title: "暂无有效评论样本",
        detail: "Worker 已收到插件采集结果，但没有可标注评论。建议先增加随机延迟或每帖评论数后重试。",
        tone: "info"
      }
    ];
  }

  const dominant = Object.values(input.distribution).sort((left, right) => right.count - left.count)[0];
  const negative = input.distribution.negative;
  const positive = input.distribution.positive;
  const activePost = input.posts
    .map((post) => ({ post, count: post.comments.length }))
    .sort((left, right) => right.count - left.count)[0];
  const highConfidence = input.labeledSamples.filter((sample) => sample.confidence >= 0.75).length;

  return [
    {
      title: "主导情绪",
      detail: `${labelDisplayName(dominant.label)}评论 ${dominant.count} 条，占 ${Math.round(dominant.ratio * 100)}%。`,
      tone: dominant.label
    },
    {
      title: "负面风险",
      detail:
        negative.count === 0
          ? "当前样本没有明显负向评论。"
          : `发现 ${negative.count} 条负向评论，占 ${Math.round(negative.ratio * 100)}%，建议优先查看代表样本。`,
      tone: negative.ratio >= 0.3 ? "negative" : "neutral"
    },
    {
      title: "正向声量",
      detail:
        positive.count === 0
          ? "当前样本中正向表达较少。"
          : `正向评论 ${positive.count} 条，占 ${Math.round(positive.ratio * 100)}%，可用于提炼认可点。`,
      tone: positive.ratio >= 0.3 ? "positive" : "neutral"
    },
    {
      title: "样本覆盖",
      detail: activePost
        ? `评论最多的帖子采集到 ${activePost.count} 条评论：${activePost.post.title || activePost.post.url}`
        : `本次覆盖 ${input.totals.posts} 篇帖子。`,
      tone: "info"
    },
    {
      title: "标注可信度",
      detail: `${highConfidence}/${input.totals.validSamples} 条样本置信度不低于 75%。`,
      tone: highConfidence / input.totals.validSamples >= 0.6 ? "positive" : "neutral"
    }
  ];
}

function buildReport(input: {
  keyword: string;
  summary: string;
  insights: AnalysisInsight[];
  distribution: Record<SentimentLabel, SentimentBucket>;
  totals: AnalysisTotals;
  warnings: string[];
  diagnostics?: AnalysisDiagnostics;
}): AnalysisReport {
  return {
    headline: `“${input.keyword}”小红书舆情分析`,
    executiveSummary: input.summary,
    keyFindings: input.insights,
    recommendedActions: buildRecommendedActions(input.distribution, input.totals, input.warnings),
    dataQuality: buildDataQuality(input.totals, input.warnings, input.diagnostics)
  };
}

function buildRecommendedActions(
  distribution: Record<SentimentLabel, SentimentBucket>,
  totals: AnalysisTotals,
  warnings: string[]
): string[] {
  if (totals.validSamples === 0) {
    return ["重新采集时确认帖子详情页评论区可加载。", "将每帖评论数调高到 20 以上，必要时把随机延迟调高。"];
  }
  const actions = ["查看代表样本，先核对高置信度评论是否符合业务判断。"];
  if (distribution.negative.ratio >= 0.3) {
    actions.push("优先梳理负向评论中的具体抱怨点，形成回应口径或产品改进清单。");
  }
  if (distribution.positive.ratio >= 0.3) {
    actions.push("提炼正向评论中的认可点，用于内容复盘和后续选题。");
  }
  if (warnings.length > 0 || totals.validSamples < 20) {
    actions.push("当前样本量偏小，建议扩大帖子数或每帖评论数后复核结论。");
  }
  return actions;
}

function buildDataQuality(
  totals: AnalysisTotals,
  warnings: string[],
  diagnostics?: AnalysisDiagnostics
): AnalysisReport["dataQuality"] {
  if (totals.validSamples === 0) {
    return {
      level: "weak",
      message: diagnostics?.advice || "没有有效评论样本，报告只能说明采集状态，不能代表舆情趋势。"
    };
  }
  if (warnings.length > 0 || totals.validSamples < 20) {
    return {
      level: "limited",
      message: `有效样本 ${totals.validSamples} 条，适合快速判断方向，建议补采后用于正式结论。`
    };
  }
  return {
    level: "good",
    message: `有效样本 ${totals.validSamples} 条，覆盖 ${totals.posts} 篇帖子，可用于当前关键词的阶段性判断。`
  };
}

function labelDisplayName(label: SentimentLabel): string {
  return {
    positive: "正向",
    neutral: "中性",
    negative: "负向"
  }[label];
}

function buildExportInfo(keyword: string) {
  const safeKeyword = keyword.replace(/[^\p{Script=Han}\w-]+/gu, "-").slice(0, 40) || "keyword";
  return {
    jsonFilename: `public-opinion-${safeKeyword}.json`,
    csvFilename: `public-opinion-${safeKeyword}.csv`,
    markdownFilename: `public-opinion-${safeKeyword}.md`
  };
}
