#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { BranchManager } from './branchManager.js';
import { BranchingThoughtInput } from './types.js';
import chalk from 'chalk';

class BranchingThoughtServer {
  private branchManager = new BranchManager();

  // Handle thought creation
  processThought(input: any): { content: Array<{ type: string; text: string }>; isError?: boolean } {
    try {
      // 兼容处理：如果 crossRefs 是字符串数组，尝试将其转换为对象结构（虽然逻辑上很难完美还原，但至少保证不崩）
      // 或者干脆在存储时就接受简化版
      const processedInput = { ...input };
      
      // 如果 AI 传来的 crossRefs 是简单的字符串数组（为了兼容 LibreChat），我们在后端做一点适配
      // 这里我们假设后端 BranchManager 暂时可以处理缺失详细信息的引用，或者我们在存入前不做强校验
      // 实际上，为了严格兼容，我们可能需要修改 types.ts，但为了不破坏太多，我们这里做个简单的 cast
      
      const thought = this.branchManager.addThought(processedInput);
      const branch = this.branchManager.getBranch(thought.branchId)!;
      
      const formattedStatus = this.branchManager.formatBranchStatus(branch);
      console.error(formattedStatus); // Display in the console

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            thoughtId: thought.id,
            branchId: thought.branchId,
            branchState: branch.state,
            branchPriority: branch.priority,
            numInsights: branch.insights.length,
            numCrossRefs: branch.crossRefs.length,
            activeBranch: this.branchManager.getActiveBranch()?.id
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            status: 'failed'
          }, null, 2)
        }],
        isError: true
      };
    }
  }

  // Handle commands
  handleCommand(commandType: string, branchId?: string): { content: Array<{ type: string; text: string }>; isError?: boolean } {
    try {
      switch (commandType) {
        case 'list': {
          const branches = this.branchManager.getAllBranches();
          const activeBranchId = this.branchManager.getActiveBranch()?.id;
          const output = branches.map(b => {
            const isActive = b.id === activeBranchId;
            const prefix = isActive ? chalk.green('→') : ' ';
            return `${prefix} ${b.id} [${b.state}] - ${b.thoughts[b.thoughts.length - 1]?.content.slice(0, 50)}...`;
          }).join('\n');
          
          return {
            content: [{
              type: "text",
              text: `Current Branches:\n${output}`
            }]
          };
        }

        case 'focus': {
          if (!branchId) {
            throw new Error('branchId required for focus command');
          }
          this.branchManager.setActiveBranch(branchId);
          const branch = this.branchManager.getBranch(branchId)!;
          const formattedStatus = this.branchManager.formatBranchStatus(branch);
          console.error(formattedStatus);
          
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                status: 'success',
                message: `Now focused on branch: ${branchId}`,
                activeBranch: branchId
              }, null, 2)
            }]
          };
        }

        case 'history': {
          const targetBranchId = branchId || this.branchManager.getActiveBranch()?.id;
          if (!targetBranchId) {
            throw new Error('No active branch and no branchId provided');
          }
          const history = this.branchManager.getBranchHistory(targetBranchId);
          
          return {
            content: [{
              type: "text",
              text: history
            }]
          };
        }

        default:
          throw new Error(`Unknown command: ${commandType}`);
      }
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            status: 'failed'
          }, null, 2)
        }],
        isError: true
      };
    }
  }
}

// Tool 1: 专门用于“思考” (扁平化 Schema)
const THINK_TOOL: Tool = {
  name: "branch-think",
  description: `Record a new thought. Use this for analysis, hypothesis, or observations in the branching thought process.
  
Each thought can:
- Belong to a specific branch
- Generate insights
- Create cross-references to other branches`,
  inputSchema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "The thought content"
      },
      branchId: {
        type: "string",
        description: "Optional: ID of the branch (generated if not provided)"
      },
      parentBranchId: {
        type: "string",
        description: "Optional: ID of the parent branch"
      },
      type: {
        type: "string",
        description: "Type of thought (e.g., 'analysis', 'hypothesis', 'observation')"
      },
      confidence: {
        type: "number",
        description: "Optional: Confidence score (0-1)"
      },
      keyPoints: {
        type: "array",
        items: { type: "string" },
        description: "Optional: Key points identified in the thought"
      },
      relatedInsights: {
        type: "array",
        items: { type: "string" },
        description: "Optional: IDs of related insights"
      },
      // ⚠️ 修改：将 crossRefs 简化为字符串数组，彻底规避 LibreChat 对嵌套对象的解析问题
      crossRefs: {
        type: "array",
        items: { type: "string" }, 
        description: "Optional: Cross-references strings (e.g. 'target-branch-id: reason')"
      }
    },
    required: ["content", "type"]
  }
};

// Tool 2: 专门用于“管理” (扁平化 Schema)
const MANAGEMENT_TOOL: Tool = {
  name: "branch-management",
  description: "Manage branches: list all branches, focus on a specific branch, or view branch history.",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        enum: ["list", "focus", "history"],
        description: "Command to execute"
      },
      branchId: {
        type: "string",
        description: "Branch ID (required for 'focus' and specific 'history')"
      }
    },
    required: ["command"]
  }
};

const server = new Server(
  {
    name: "branch-thinking-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const thinkingServer = new BranchingThoughtServer();

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [THINK_TOOL, MANAGEMENT_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "branch-think") {
    // 强制类型转换，因为我们简化了 inputSchema，但 processThought 内部可能还能处理部分兼容数据
    return thinkingServer.processThought(request.params.arguments);
  }
  
  if (request.params.name === "branch-management") {
    const args = request.params.arguments as any;
    return thinkingServer.handleCommand(args.command, args.branchId);
  }

  return {
    content: [{
      type: "text",
      text: `Unknown tool: ${request.params.name}`
    }],
    isError: true
  };
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Branch Thinking MCP Server running on stdio");
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
