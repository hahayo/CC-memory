/**
 * Supabase 儲存層
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  Memory,
  SearchResult,
  ProjectStats,
  ProjectInfo,
  StorageConfig
} from './types.js';

export class SupabaseStorage {
  private client: SupabaseClient;

  constructor(config: StorageConfig) {
    this.client = createClient(config.supabaseUrl, config.supabaseKey);
  }

  /**
   * 儲存記憶
   */
  async saveMemory(memory: Memory): Promise<{ id: string }> {
    const { data, error } = await this.client
      .from('project_memories')
      .insert({
        project_name: memory.project_name,
        project_path: memory.project_path,
        session_id: memory.session_id,
        summary: memory.summary,
        keywords: memory.keywords,
        decisions: memory.decisions,
        tech_stack: memory.tech_stack,
        embedding: memory.embedding,
        metadata: memory.metadata || {}
      })
      .select('id')
      .single();

    if (error) {
      throw new Error(`Failed to save memory: ${error.message}`);
    }

    return { id: data.id };
  }

  /**
   * 向量搜尋
   */
  async searchByVector(
    embedding: number[],
    project?: string,
    limit: number = 5,
    threshold: number = 0.5
  ): Promise<SearchResult[]> {
    const { data, error } = await this.client
      .rpc('search_memories', {
        query_embedding: embedding,
        filter_project: project || null,
        match_count: limit,
        similarity_threshold: threshold
      });

    if (error) {
      throw new Error(`Vector search failed: ${error.message}`);
    }

    return data || [];
  }

  /**
   * 關鍵字搜尋
   */
  async searchByKeywords(
    keywords: string[],
    project?: string,
    limit: number = 10
  ): Promise<SearchResult[]> {
    const { data, error } = await this.client
      .rpc('search_by_keywords', {
        search_keywords: keywords,
        filter_project: project || null,
        match_count: limit
      });

    if (error) {
      throw new Error(`Keyword search failed: ${error.message}`);
    }

    return data || [];
  }

  /**
   * 全文搜尋
   */
  async searchFulltext(
    query: string,
    project?: string,
    limit: number = 10
  ): Promise<SearchResult[]> {
    const { data, error } = await this.client
      .rpc('search_fulltext', {
        search_query: query,
        filter_project: project || null,
        match_count: limit
      });

    if (error) {
      throw new Error(`Fulltext search failed: ${error.message}`);
    }

    return data || [];
  }

  /**
   * 列出專案記憶
   */
  async listProjectMemories(
    project: string,
    pageSize: number = 20,
    offset: number = 0
  ): Promise<SearchResult[]> {
    const { data, error } = await this.client
      .rpc('list_project_memories', {
        filter_project: project,
        page_size: pageSize,
        page_offset: offset
      });

    if (error) {
      throw new Error(`List memories failed: ${error.message}`);
    }

    return data || [];
  }

  /**
   * 取得專案統計
   */
  async getProjectStats(project: string): Promise<ProjectStats | null> {
    const { data, error } = await this.client
      .rpc('get_project_stats', {
        filter_project: project
      })
      .single();

    if (error) {
      throw new Error(`Get stats failed: ${error.message}`);
    }

    return data;
  }

  /**
   * 列出所有專案
   */
  async listProjects(): Promise<ProjectInfo[]> {
    const { data, error } = await this.client
      .rpc('list_projects');

    if (error) {
      throw new Error(`List projects failed: ${error.message}`);
    }

    return data || [];
  }

  /**
   * 刪除記憶
   */
  async deleteMemory(id: string): Promise<void> {
    const { error } = await this.client
      .from('project_memories')
      .delete()
      .eq('id', id);

    if (error) {
      throw new Error(`Delete memory failed: ${error.message}`);
    }
  }

  /**
   * 取得單一記憶
   */
  async getMemory(id: string): Promise<Memory | null> {
    const { data, error } = await this.client
      .from('project_memories')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null; // Not found
      }
      throw new Error(`Get memory failed: ${error.message}`);
    }

    return data;
  }

  /**
   * 更新記憶
   */
  async updateMemory(id: string, updates: Partial<Memory>): Promise<void> {
    const { error } = await this.client
      .from('project_memories')
      .update(updates)
      .eq('id', id);

    if (error) {
      throw new Error(`Update memory failed: ${error.message}`);
    }
  }
}
