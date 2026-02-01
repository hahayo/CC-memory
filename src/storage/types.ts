/**
 * CC-memory 型別定義
 */

export interface Memory {
  id?: string;
  project_name: string;
  project_path?: string;
  session_id?: string;
  summary: string;
  keywords: string[];
  decisions: string[];
  tech_stack: string[];
  embedding?: number[];
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface SearchResult {
  id: string;
  project_name: string;
  summary: string;
  keywords: string[];
  decisions?: string[];
  tech_stack?: string[];
  similarity?: number;
  rank?: number;
  match_score?: number;
  created_at: string;
}

export interface ProjectStats {
  total_memories: number;
  first_memory: string;
  last_memory: string;
  top_keywords: string[];
}

export interface ProjectInfo {
  project_name: string;
  memory_count: number;
  last_updated: string;
}

export interface ExtractedMemory {
  summary: string;
  keywords: string[];
  decisions: string[];
  tech_stack: string[];
}

export interface SessionMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

export interface StorageConfig {
  supabaseUrl: string;
  supabaseKey: string;
}
