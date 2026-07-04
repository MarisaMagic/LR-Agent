import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, GaugeChart, PieChart, RadarChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';
import { applyChartTheme } from '../../services/annotationQuality/chartTheme';

echarts.use([
  BarChart,
  PieChart,
  RadarChart,
  GaugeChart,
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  CanvasRenderer,
]);

interface QualityEChartProps {
  option: EChartsOption;
  isDark: boolean;
  height?: number;
}

export default function QualityEChart({
  option,
  isDark,
  height = 220,
}: QualityEChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;

    const chart = echarts.init(el, undefined, { renderer: 'canvas' });
    chartRef.current = chart;

    const observer = new ResizeObserver(() => {
      chart.resize();
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.setOption(applyChartTheme(option, isDark), true);
  }, [option, isDark]);

  return (
    <div
      ref={containerRef}
      className="quality-echart"
      style={{ width: '100%', height }}
    />
  );
}
