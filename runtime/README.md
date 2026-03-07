# Conda Fallback Runtime

Use this only when Docker/Apptainer are unavailable.

## Setup

```bash
runtime/setup_conda_fallback.sh
```

Custom env name:

```bash
runtime/setup_conda_fallback.sh my_wcecoli_env
```

## Notes

- Mirrors dependency ordering from your validated setup notes.
- Pins conflict-prone tooling and packages before bulk requirements install.
- Compiles C extensions and performs editable install (best effort).
