"""
Standalone reader for wcEcoli's TableWriter binary format (IFF chunks + zlib).

This replaces the dependency on wholecell.io.tablereader which has transitive
imports (IPython via forkedPdb) that are unavailable in the slim API container.

The binary format:
  Each simOut/<ListenerName>/<column_name> is a file with:
    1. A header chunk (type COLM or VCOL) containing:
       - For COLM: bytes_per_entry, elements_per_entry, entries_per_block,
         compression_type (packed as >2I 2H), then JSON dtype descriptor
       - For VCOL: compression_type (packed as H), then JSON dtype descriptor
    2. One or more BLOC data chunks (zlib-compressed numpy arrays)
    3. For VCOL: matching RWSZ row-size chunks

  Each chunk follows EA IFF 85 format:
    4 bytes type ID + 4 bytes big-endian size + <size> bytes data
"""

import json
import struct
import zlib
from pathlib import Path
from typing import Any, Optional

import numpy as np

# ── Constants from wcEcoli tablewriter ──────────────────────────────────

VERSION = 3
FILE_ATTRIBUTES = "attributes.json"
COLUMN_CHUNK_TYPE = b'COLM'
VARIABLE_COLUMN_CHUNK_TYPE = b'VCOL'
BLOCK_CHUNK_TYPE = b'BLOC'
ROW_SIZE_CHUNK_TYPE = b'RWSZ'
ROW_SIZE_CHUNK_DTYPE = np.uint32
COLUMN_STRUCT = struct.Struct('>2I 2H')      # bytes_per_entry, elements, entries_per_block, compression
VARIABLE_COLUMN_STRUCT = struct.Struct('H')   # compression_type only
COMPRESSION_TYPE_NONE = 0
COMPRESSION_TYPE_ZLIB = 1


# ── IFF Chunk reader ───────────────────────────────────────────────────

class _Chunk:
    """Minimal IFF 85 chunk reader (no alignment, big-endian)."""
    __slots__ = ('name', 'size', 'data')

    def __init__(self, f):
        hdr = f.read(8)
        if len(hdr) < 8:
            raise EOFError
        self.name = hdr[:4]
        self.size = struct.unpack('>I', hdr[4:8])[0]
        self.data = f.read(self.size)
        if len(self.data) < self.size:
            raise EOFError(f'Chunk cut short: {len(self.data)}/{self.size}')


# ── Column reader ──────────────────────────────────────────────────────

def read_column(table_dir, column_name, squeeze=True):
    """Read a single column from a wcEcoli TableWriter directory.

    Args:
        table_dir: Path to the table directory (e.g., simOut/Mass)
        column_name: Name of the column file (e.g., "cellMass")
        squeeze: Whether to squeeze singleton dimensions

    Returns:
        numpy array of the column data
    """
    col_path = Path(table_dir) / column_name
    if not col_path.exists():
        raise FileNotFoundError(f"Column not found: {col_path}")

    entry_blocks = []
    row_size_blocks = []

    with open(col_path, 'rb') as f:
        # Read header chunk
        hdr_chunk = _Chunk(f)
        variable_length = hdr_chunk.name == VARIABLE_COLUMN_CHUNK_TYPE

        if hdr_chunk.name not in (COLUMN_CHUNK_TYPE, VARIABLE_COLUMN_CHUNK_TYPE):
            raise ValueError(f'Not a valid column file: chunk type {hdr_chunk.name!r}')

        if variable_length:
            (compression_type,) = VARIABLE_COLUMN_STRUCT.unpack(
                hdr_chunk.data[:VARIABLE_COLUMN_STRUCT.size])
            dtype_json = hdr_chunk.data[VARIABLE_COLUMN_STRUCT.size:]
        else:
            vals = COLUMN_STRUCT.unpack(hdr_chunk.data[:COLUMN_STRUCT.size])
            bytes_per_entry, elements_per_entry, entries_per_block, compression_type = vals
            dtype_json = hdr_chunk.data[COLUMN_STRUCT.size:]

        # Parse dtype
        descr = json.loads(dtype_json)
        if isinstance(descr, str):
            dtype = np.dtype(descr)
        else:
            dtype = np.dtype([(str(n), str(t)) for n, t in descr])

        # Decompressor
        if compression_type == COMPRESSION_TYPE_ZLIB:
            decompress = zlib.decompress
        else:
            decompress = lambda x: x

        # Read data chunks
        while True:
            try:
                chunk = _Chunk(f)
            except EOFError:
                break

            if chunk.name == BLOCK_CHUNK_TYPE:
                entry_blocks.append(chunk.data)
            elif chunk.name == ROW_SIZE_CHUNK_TYPE:
                row_size_blocks.append(chunk.data)

    if not entry_blocks:
        return np.array([])

    # Variable-length columns
    if variable_length:
        row_sizes_list = [np.frombuffer(b, ROW_SIZE_CHUNK_DTYPE) for b in row_size_blocks]
        all_row_sizes = np.concatenate(row_sizes_list)
        max_cols = int(all_row_sizes.max()) if len(all_row_sizes) > 0 else 0
        result = np.full((len(all_row_sizes), max_cols), np.nan)

        row = 0
        for raw, rsizes in zip(entry_blocks, row_sizes_list):
            entries = np.frombuffer(decompress(raw), dtype)
            idx = 0
            for rs in rsizes:
                result[row, :rs] = entries[idx:idx + rs]
                idx += rs
                row += 1
        return result

    # Fixed-length columns
    def decomp_block(raw):
        return np.frombuffer(decompress(raw), dtype).reshape(-1, elements_per_entry)

    last_entries = decomp_block(entry_blocks.pop())
    last_num_rows = last_entries.shape[0]
    num_rows = len(entry_blocks) * entries_per_block + last_num_rows
    result = np.zeros((num_rows, elements_per_entry), dtype)

    row = 0
    for raw in entry_blocks:
        entries = decomp_block(raw)
        n = entries.shape[0]
        result[row:row + n] = entries
        row += n
    result[row:row + last_num_rows] = last_entries

    if squeeze:
        result = result.squeeze()
    return result


def read_column_slice(table_dir, column_name, indices):
    """Read specific subcolumn indices from a fixed-length column.

    More memory-efficient than reading the full column when only a few
    subcolumns are needed out of thousands (e.g., 3 proteins out of 4435).

    Args:
        table_dir: Path to the table directory
        column_name: Name of the column file
        indices: List of subcolumn indices to extract

    Returns:
        numpy array of shape (rows, len(indices))
    """
    full = read_column(table_dir, column_name, squeeze=False)
    if full.ndim < 2:
        return full
    return full[:, indices]


def read_attribute(table_dir, attr_name):
    """Read an attribute from a table's attributes.json."""
    attrs_path = Path(table_dir) / FILE_ATTRIBUTES
    if not attrs_path.exists():
        raise FileNotFoundError(f"No attributes file: {attrs_path}")
    attrs = json.loads(attrs_path.read_text())
    if attr_name not in attrs:
        raise KeyError(f"No such attribute: {attr_name}")
    return attrs[attr_name]


def read_all_attributes(table_dir):
    """Read all attributes from a table's attributes.json."""
    attrs_path = Path(table_dir) / FILE_ATTRIBUTES
    if not attrs_path.exists():
        raise FileNotFoundError(f"No attributes file: {attrs_path}")
    return json.loads(attrs_path.read_text())


def list_columns(table_dir):
    """List available column names in a table directory."""
    table_dir = Path(table_dir)
    return sorted(
        p.name for p in table_dir.iterdir()
        if p.is_file() and p.name != FILE_ATTRIBUTES
    )


def table_exists(sim_out, table_name):
    """Check if a table directory exists with a valid attributes file."""
    p = Path(sim_out) / table_name
    return p.is_dir() and (p / FILE_ATTRIBUTES).exists()
