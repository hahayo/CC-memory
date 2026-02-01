-- CC-memory Supabase Schema
-- 執行此 SQL 來建立所需的資料表和函數

-- 啟用 pgvector 擴展
CREATE EXTENSION IF NOT EXISTS vector;

-- 專案記憶表
CREATE TABLE IF NOT EXISTS project_memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- 專案識別
    project_name TEXT NOT NULL,
    project_path TEXT,

    -- Session 資訊
    session_id TEXT,

    -- 記憶內容
    summary TEXT NOT NULL,
    keywords TEXT[] DEFAULT '{}',
    decisions TEXT[] DEFAULT '{}',
    tech_stack TEXT[] DEFAULT '{}',

    -- 向量 embedding (384 維度，適合 all-MiniLM-L6-v2)
    -- 如果使用其他模型，調整維度
    embedding VECTOR(384),

    -- 元資料
    metadata JSONB DEFAULT '{}',

    -- 時間戳記
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 索引：按專案查詢
CREATE INDEX IF NOT EXISTS idx_memories_project
ON project_memories(project_name);

-- 索引：按時間查詢
CREATE INDEX IF NOT EXISTS idx_memories_created
ON project_memories(created_at DESC);

-- 索引：向量搜尋 (IVFFlat)
CREATE INDEX IF NOT EXISTS idx_memories_embedding
ON project_memories
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- 索引：關鍵字搜尋 (GIN)
CREATE INDEX IF NOT EXISTS idx_memories_keywords
ON project_memories
USING GIN (keywords);

-- 全文搜尋索引
CREATE INDEX IF NOT EXISTS idx_memories_summary_fts
ON project_memories
USING GIN (to_tsvector('english', summary));

-- 更新時間觸發器
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_updated_at
    BEFORE UPDATE ON project_memories
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- 向量搜尋函數
CREATE OR REPLACE FUNCTION search_memories(
    query_embedding VECTOR(384),
    filter_project TEXT DEFAULT NULL,
    match_count INT DEFAULT 5,
    similarity_threshold FLOAT DEFAULT 0.5
)
RETURNS TABLE (
    id UUID,
    project_name TEXT,
    summary TEXT,
    keywords TEXT[],
    decisions TEXT[],
    tech_stack TEXT[],
    similarity FLOAT,
    created_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        pm.id,
        pm.project_name,
        pm.summary,
        pm.keywords,
        pm.decisions,
        pm.tech_stack,
        1 - (pm.embedding <=> query_embedding) AS similarity,
        pm.created_at
    FROM project_memories pm
    WHERE
        pm.embedding IS NOT NULL
        AND (filter_project IS NULL OR pm.project_name = filter_project)
        AND (1 - (pm.embedding <=> query_embedding)) > similarity_threshold
    ORDER BY pm.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- 關鍵字搜尋函數
CREATE OR REPLACE FUNCTION search_by_keywords(
    search_keywords TEXT[],
    filter_project TEXT DEFAULT NULL,
    match_count INT DEFAULT 10
)
RETURNS TABLE (
    id UUID,
    project_name TEXT,
    summary TEXT,
    keywords TEXT[],
    match_score INT,
    created_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        pm.id,
        pm.project_name,
        pm.summary,
        pm.keywords,
        CARDINALITY(ARRAY(
            SELECT UNNEST(pm.keywords)
            INTERSECT
            SELECT UNNEST(search_keywords)
        )) AS match_score,
        pm.created_at
    FROM project_memories pm
    WHERE
        (filter_project IS NULL OR pm.project_name = filter_project)
        AND pm.keywords && search_keywords
    ORDER BY match_score DESC, pm.created_at DESC
    LIMIT match_count;
END;
$$;

-- 全文搜尋函數
CREATE OR REPLACE FUNCTION search_fulltext(
    search_query TEXT,
    filter_project TEXT DEFAULT NULL,
    match_count INT DEFAULT 10
)
RETURNS TABLE (
    id UUID,
    project_name TEXT,
    summary TEXT,
    keywords TEXT[],
    rank FLOAT,
    created_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        pm.id,
        pm.project_name,
        pm.summary,
        pm.keywords,
        ts_rank(to_tsvector('english', pm.summary), plainto_tsquery('english', search_query)) AS rank,
        pm.created_at
    FROM project_memories pm
    WHERE
        (filter_project IS NULL OR pm.project_name = filter_project)
        AND to_tsvector('english', pm.summary) @@ plainto_tsquery('english', search_query)
    ORDER BY rank DESC, pm.created_at DESC
    LIMIT match_count;
END;
$$;

-- 列出專案所有記憶
CREATE OR REPLACE FUNCTION list_project_memories(
    filter_project TEXT,
    page_size INT DEFAULT 20,
    page_offset INT DEFAULT 0
)
RETURNS TABLE (
    id UUID,
    summary TEXT,
    keywords TEXT[],
    decisions TEXT[],
    created_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        pm.id,
        pm.summary,
        pm.keywords,
        pm.decisions,
        pm.created_at
    FROM project_memories pm
    WHERE pm.project_name = filter_project
    ORDER BY pm.created_at DESC
    LIMIT page_size
    OFFSET page_offset;
END;
$$;

-- 取得專案統計
CREATE OR REPLACE FUNCTION get_project_stats(filter_project TEXT)
RETURNS TABLE (
    total_memories BIGINT,
    first_memory TIMESTAMP WITH TIME ZONE,
    last_memory TIMESTAMP WITH TIME ZONE,
    top_keywords TEXT[]
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(*)::BIGINT AS total_memories,
        MIN(pm.created_at) AS first_memory,
        MAX(pm.created_at) AS last_memory,
        (
            SELECT ARRAY_AGG(keyword ORDER BY cnt DESC)
            FROM (
                SELECT UNNEST(pm2.keywords) AS keyword, COUNT(*) AS cnt
                FROM project_memories pm2
                WHERE pm2.project_name = filter_project
                GROUP BY keyword
                LIMIT 10
            ) sub
        ) AS top_keywords
    FROM project_memories pm
    WHERE pm.project_name = filter_project;
END;
$$;

-- 列出所有專案
CREATE OR REPLACE FUNCTION list_projects()
RETURNS TABLE (
    project_name TEXT,
    memory_count BIGINT,
    last_updated TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        pm.project_name,
        COUNT(*)::BIGINT AS memory_count,
        MAX(pm.created_at) AS last_updated
    FROM project_memories pm
    GROUP BY pm.project_name
    ORDER BY last_updated DESC;
END;
$$;
