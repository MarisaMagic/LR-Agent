import type { EChartsOption } from 'echarts';

export function applyChartTheme(
  option: EChartsOption,
  isDark: boolean,
): EChartsOption {
  const textColor = isDark ? '#cccccc' : '#333333';
  const axisLine = isDark ? '#555555' : '#cccccc';
  const splitLine = isDark ? '#3e3e42' : '#eeeeee';

  return {
    backgroundColor: 'transparent',
    textStyle: { color: textColor },
    title: {
      ...(typeof option.title === 'object' && !Array.isArray(option.title)
        ? option.title
        : {}),
      textStyle: { color: textColor, fontSize: 14 },
    },
    legend: {
      ...(option.legend && typeof option.legend === 'object'
        ? option.legend
        : {}),
      textStyle: { color: textColor },
    },
    xAxis: Array.isArray(option.xAxis)
      ? option.xAxis.map((axis) => ({
          ...axis,
          axisLine: { lineStyle: { color: axisLine } },
          axisLabel: { color: textColor },
          splitLine: { lineStyle: { color: splitLine } },
        }))
      : option.xAxis
        ? {
            ...option.xAxis,
            axisLine: { lineStyle: { color: axisLine } },
            axisLabel: { color: textColor },
            splitLine: { lineStyle: { color: splitLine } },
          }
        : undefined,
    yAxis: Array.isArray(option.yAxis)
      ? option.yAxis.map((axis) => ({
          ...axis,
          axisLine: { lineStyle: { color: axisLine } },
          axisLabel: { color: textColor },
          splitLine: { lineStyle: { color: splitLine } },
        }))
      : option.yAxis
        ? {
            ...option.yAxis,
            axisLine: { lineStyle: { color: axisLine } },
            axisLabel: { color: textColor },
            splitLine: { lineStyle: { color: splitLine } },
          }
        : undefined,
    series: option.series,
    radar: option.radar
      ? {
          ...option.radar,
          axisName: { color: textColor },
          splitLine: { lineStyle: { color: splitLine } },
          splitArea: { areaStyle: { color: isDark ? ['#2d2d30', '#252526'] : ['#fafafa', '#ffffff'] } },
        }
      : undefined,
  };
}
