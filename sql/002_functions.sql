-- pgmem ranking functions.

-- Exponential recency decay: 1.0 at event_time = now(), 0.5 one half-life
-- later, 0.25 after two half-lives. 0.6931471805599453 is ln(2).
CREATE OR REPLACE FUNCTION pgmem_decay_factor(event_time timestamptz, half_life_hours double precision)
RETURNS double precision
LANGUAGE SQL STABLE
RETURN exp(-0.6931471805599453
           * greatest(extract(epoch FROM (now() - event_time))::double precision, 0.0)
           / (half_life_hours * 3600.0));

-- Combined memory score: cosine similarity x recency decay x importance.
CREATE OR REPLACE FUNCTION pgmem_score(memory_embedding vector, query_embedding vector, last_accessed_at timestamptz, importance real, half_life_hours double precision)
RETURNS double precision
LANGUAGE SQL STABLE
RETURN (1.0 - (memory_embedding <=> query_embedding))
       * pgmem_decay_factor(last_accessed_at, half_life_hours)
       * importance::double precision;
