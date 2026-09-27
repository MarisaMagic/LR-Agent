import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  appendExperimentEvent,
  flushExperimentLog,
  isExperimentLogEnabled,
  resolveExperimentLogFile,
} from './logger';

describe('experiment logger', () => {
  const originalLog = process.env.LR_AGENT_EXPERIMENT_LOG;
  const originalRun = process.env.LR_AGENT_EXPERIMENT_RUN;
  let tmpDir = '';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-exp-log-'));
    delete process.env.LR_AGENT_EXPERIMENT_LOG;
    delete process.env.LR_AGENT_EXPERIMENT_RUN;
  });

  afterEach(async () => {
    await flushExperimentLog();
    await fs.remove(tmpDir);
    if (originalLog === undefined) delete process.env.LR_AGENT_EXPERIMENT_LOG;
    else process.env.LR_AGENT_EXPERIMENT_LOG = originalLog;
    if (originalRun === undefined) delete process.env.LR_AGENT_EXPERIMENT_RUN;
    else process.env.LR_AGENT_EXPERIMENT_RUN = originalRun;
  });

  it('未设置环境变量时不启用、不写文件', async () => {
    expect(isExperimentLogEnabled()).toBe(false);
    expect(resolveExperimentLogFile()).toBeNull();

    appendExperimentEvent({ type: 'image_open' });
    await flushExperimentLog();

    expect((await fs.readdir(tmpDir)).length).toBe(0);
  });

  it('目录值写 events.jsonl，带 ts 与 run 标签', async () => {
    process.env.LR_AGENT_EXPERIMENT_LOG = tmpDir;
    process.env.LR_AGENT_EXPERIMENT_RUN = 'C-s1';

    expect(isExperimentLogEnabled()).toBe(true);
    expect(resolveExperimentLogFile()).toBe(path.join(tmpDir, 'events.jsonl'));

    appendExperimentEvent({ type: 'image_open', relativePath: 'a.jpg' });
    appendExperimentEvent({ type: 'ai_generate', ok: true });
    await flushExperimentLog();

    const lines = (await fs.readFile(path.join(tmpDir, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0].type).toBe('image_open');
    expect(lines[0].run).toBe('C-s1');
    expect(lines[0].relativePath).toBe('a.jpg');
    expect(typeof lines[0].ts).toBe('string');
    expect(lines[1].type).toBe('ai_generate');
  });

  it('值为 .jsonl 路径时直接写该文件', async () => {
    const file = path.join(tmpDir, 'run.jsonl');
    process.env.LR_AGENT_EXPERIMENT_LOG = file;
    expect(resolveExperimentLogFile()).toBe(file);

    appendExperimentEvent({ type: 'image_save' });
    await flushExperimentLog();

    expect(await fs.pathExists(file)).toBe(true);
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(parsed.run).toBeNull();
  });
});
