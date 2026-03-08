export type FlowData = {
  path: string | string[];
};

export type FlowOutput = {
  source?: FlowData;
  dest?: FlowData;
};

export interface Flow {
  id: string;
  execute(): Promise<FlowOutput>;
}

export interface Runner {
  run: (input: FlowOutput) => Promise<void>;
}
