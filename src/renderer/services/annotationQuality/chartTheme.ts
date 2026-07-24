import type { EChartsOption } from 'echarts';

type AxisOption = NonNullable<EChartsOption['xAxis']> extends (infer T)[]
  ? T
  : NonNullable<EChartsOption['xAxis']>;

type SeriesItem = NonNullable<EChartsOption['series']> extends (infer T)[]
  ? T
  : NonNullable<EChartsOption['series']>;

/* ── VSCode 风格调色板 ──
   使用 VSCode 语义色，与编辑器主题保持一致 */
function chartColors(isDark: boolean): string[] {
  return isDark
    ? [
        '#5299e0', // blue
        '#6cc76c', // green
        '#e0a050', // orange
        '#e06c75', // red
        '#c678dd', // purple
        '#56b6c2', // cyan
        '#e5c07b', // yellow
        '#98c379', // lime
        '#61afef', // light blue
        '#be5046', // dark red
      ]
    : [
        '#2977c8', // blue
        '#3a8c3a', // green
        '#c27c20', // orange
        '#c53030', // red
        '#8b3eb3', // purple
        '#2a8f9c', // cyan
        '#b8962a', // yellow
        '#5a8c3a', // lime
        '#3778b8', // light blue
        '#a04040', // dark red
      ];
}

/* ── 坐标轴主题 ── */
function themeAxis(
  axis: AxisOption,
  textColor: string,
  axisLine: string,
  splitLine: string,
) {
  const axisLabel =
    axis && typeof axis === 'object' && 'axisLabel' in axis && axis.axisLabel
      ? axis.axisLabel
      : undefined;
  const nameTextStyle =
    axis && typeof axis === 'object' && 'nameTextStyle' in axis && axis.nameTextStyle
      ? axis.nameTextStyle
      : undefined;

  return {
    ...axis,
    axisLine: { lineStyle: { color: axisLine, width: 1 } },
    axisTick: { lineStyle: { color: axisLine } },
    axisLabel: {
      ...(typeof axisLabel === 'object' ? axisLabel : {}),
      color: textColor,
    },
    nameTextStyle: {
      ...(typeof nameTextStyle === 'object' ? nameTextStyle : {}),
      color: textColor,
    },
    splitLine: { lineStyle: { color: splitLine, width: 0.5 } },
  };
}

/* ── series 增强 ──
   按图表类型注入圆角、hover 效果等 */
function themeSeries(
  series: EChartsOption['series'],
  textColor: string,
  isDark: boolean,
): EChartsOption['series'] {
  if (!series) return series;
  const list = Array.isArray(series) ? series : [series];

  return list.map((item, idx) => {
    if (!item || typeof item !== 'object') return item;

    /* bar 类型: 顶部圆角 + hover 放大 */
    if (item.type === 'bar') {
      const barItem = { ...item } as Record<string, unknown> & { itemStyle?: Record<string, unknown>; emphasis?: Record<string, unknown> };
      barItem.itemStyle = {
        ...barItem.itemStyle,
        borderRadius: [4, 4, 0, 0],
      };
      barItem.emphasis = {
        ...barItem.emphasis,
        itemStyle: {
          ...(barItem.emphasis?.itemStyle as Record<string, unknown> || {}),
          shadowBlur: 8,
          shadowColor: 'rgba(0,0,0,0.25)',
          shadowOffsetY: 2,
        },
      };
      return barItem as SeriesItem;
    }

    /* pie 类型: hover 外扩 + label 色 */
    if (item.type === 'pie') {
      const pieItem = { ...item } as Record<string, unknown> & {
        label?: Record<string, unknown>;
        labelLine?: Record<string, unknown>;
        emphasis?: Record<string, unknown>;
      };

      pieItem.label = {
        ...pieItem.label,
        color: textColor,
      };
      pieItem.labelLine = {
        ...pieItem.labelLine,
        lineStyle: {
          ...(pieItem.labelLine?.lineStyle as Record<string, unknown> || {}),
          color: isDark ? '#888888' : '#aaaaaa',
          width: 1,
        },
      };
      pieItem.emphasis = {
        ...pieItem.emphasis,
        scaleSize: 8,
        label: {
          fontWeight: 'bold',
          fontSize: 13,
        },
      };
      return pieItem as SeriesItem;
    }

    /* radar 类型: 面积半透明填充 */
    if (item.type === 'radar') {
      const radarItem = { ...item } as Record<string, unknown> & {
        areaStyle?: Record<string, unknown>;
        lineStyle?: Record<string, unknown>;
        emphasis?: Record<string, unknown>;
      };
      radarItem.areaStyle = {
        ...radarItem.areaStyle,
        opacity: isDark ? 0.12 : 0.08,
      };
      radarItem.lineStyle = {
        ...radarItem.lineStyle,
        width: 2,
      };
      radarItem.emphasis = {
        ...radarItem.emphasis,
        lineStyle: {
          ...(radarItem.emphasis?.lineStyle as Record<string, unknown> || {}),
          width: 3,
        },
      };
      return radarItem as SeriesItem;
    }

    return item;
  }) as SeriesItem[];
}

/* ── 主入口: applyChartTheme ── */
export function applyChartTheme(
  option: EChartsOption,
  isDark: boolean,
): EChartsOption {
  const textColor = isDark ? '#cccccc' : '#333333';
  const axisLine = isDark ? '#555555' : '#cccccc';
  const splitLine = isDark ? '#3e3e42' : '#eeeeee';
  const tooltipBg = isDark ? 'rgba(30, 30, 30, 0.94)' : 'rgba(255, 255, 255, 0.94)';
  const tooltipBorder = isDark ? '#454545' : '#dddddd';
  const colors = chartColors(isDark);

  return {
    color: colors,
    backgroundColor: 'transparent',
    textStyle: { color: textColor },

    /* 全局动画 */
    animationDuration: 800,
    animationEasing: 'cubicOut' as const,

    /* tooltip 样式: 匹配弹出菜单风格 */
    tooltip: {
      backgroundColor: tooltipBg,
      borderColor: tooltipBorder,
      borderWidth: 1,
      borderRadius: 6,
      textStyle: { color: textColor, fontSize: 12 },
      extraCssText: 'box-shadow: 0 8px 24px rgba(0,0,0,0.35);',
      ...(typeof option.tooltip === 'object' && !Array.isArray(option.tooltip)
        ? option.tooltip
        : {}),
    },

    title: {
      textStyle: { color: textColor, fontSize: 13, fontWeight: 600 },
      ...(typeof option.title === 'object' && !Array.isArray(option.title)
        ? option.title
        : {}),
    },

    legend: {
      textStyle: { color: textColor, fontSize: 11 },
      ...(option.legend && typeof option.legend === 'object'
        ? option.legend
        : {}),
    },

    xAxis: Array.isArray(option.xAxis)
      ? option.xAxis.map((axis) => themeAxis(axis, textColor, axisLine, splitLine))
      : option.xAxis
        ? themeAxis(option.xAxis, textColor, axisLine, splitLine)
        : undefined,

    yAxis: Array.isArray(option.yAxis)
      ? option.yAxis.map((axis) => themeAxis(axis, textColor, axisLine, splitLine))
      : option.yAxis
        ? themeAxis(option.yAxis, textColor, axisLine, splitLine)
        : undefined,

    series: themeSeries(option.series, textColor, isDark),

    radar: option.radar
      ? {
          ...option.radar,
          axisName: { color: textColor, fontSize: 11 },
          splitLine: { lineStyle: { color: splitLine, width: 0.5 } },
          splitArea: {
            areaStyle: {
              color: isDark ? ['#2d2d30', '#252526'] : ['#fafafa', '#ffffff'],
            },
          },
        }
      : undefined,
  };
}
