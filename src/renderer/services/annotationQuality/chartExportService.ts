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
import { applyChartTheme } from './chartTheme';

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

export interface ChartExportOptions {
  width?: number;
  height?: number;
  pixelRatio?: number;
  isDark?: boolean;
}

export async function renderChartToDataUrl(
  option: EChartsOption,
  exportOptions: ChartExportOptions = {},
): Promise<string> {
  const {
    width = 960,
    height = 540,
    pixelRatio = 2,
    isDark = false,
  } = exportOptions;

  const container = document.createElement('div');
  container.style.width = `${width}px`;
  container.style.height = `${height}px`;
  container.style.position = 'fixed';
  container.style.left = '-10000px';
  container.style.top = '0';
  document.body.appendChild(container);

  try {
    const chart = echarts.init(container, undefined, {
      renderer: 'canvas',
      width,
      height,
    });
    const themed = applyChartTheme(option, isDark);
    chart.setOption(themed);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    const dataUrl = chart.getDataURL({
      type: 'png',
      pixelRatio,
      backgroundColor: isDark ? '#1e1e1e' : '#ffffff',
    });
    chart.dispose();
    return dataUrl;
  } finally {
    document.body.removeChild(container);
  }
}

export function dataUrlToBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}
