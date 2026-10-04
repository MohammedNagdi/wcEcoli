import pytest

from app.services.assistant_agent import _extract_text_tool_calls, _stable_system
from app.services.assistant_output import PRESENTATION_GUIDANCE, iter_json_objects
from app.services.assistant_runtime import _system_prompt
from app.services.assistant_stream import _FenceFilter


def filtered(text, size, tools=None):
    f = _FenceFilter(tools or {"create_experiment", "inspect_result"})
    return "".join(f.feed(text[i:i + size]) for i in range(0, len(text), size)) + f.flush()


@pytest.mark.parametrize("size", [1, 2, 3, 7, 64, 1000])
@pytest.mark.parametrize("text", [
    'Before\n```python\nx = {1, 2}\nprint("value")\n```\nAfter',
    '```json\n{"name":"sample","time":3,"metadata":{"brace":"}"}}\n```',
    '~~~json\n{"gene":"dnaA","mass_fg":2344.5}\n~~~\nDone',
    '```math\nx^{2} + \\frac{1}{2}\n```\nValue $$x^{2}$$ and {a, b}.',
    'An inline ```code span``` with `x_{2}`.',
    '```text\n{"name":"sample","arguments":"example"}\n```',
    '````python\n``` is data\n````\nAfter',
    'Unfinished\n```python\nx = {1, 2}',
    '```json\n```',
    '```json\n  ',
    '~~~\n\n~~~',
    'An unclosed ordinary brace {a scientific value continues.',
])
def test_ordinary_markdown_is_preserved_at_all_chunk_boundaries(text, size):
    assert filtered(text, size) == text


@pytest.mark.parametrize("size", [1, 2, 5, 80])
@pytest.mark.parametrize("envelope", [
    '{"name":"create_experiment","arguments":{"note":"a } brace"}}',
    '{"tool":"inspect_result","parameters":{"job_id":2}}',
    '{"tool_name":"unknown_tool","input":{}}',
    '{"name":"create_experiment","parameters":{"include_wildtype":False}}',
    '{"name":"inspect_result"}',
])
def test_stream_and_final_cleanup_classify_the_same_envelopes(envelope, size):
    names = {"create_experiment", "inspect_result"}
    assert filtered('Before ' + envelope + ' After', size, names) == 'Before  After'
    cleaned, _ = _extract_text_tool_calls('Before ' + envelope + ' After', names, prefix='test')
    assert cleaned == 'Before  After'
    assert filtered('Before\n```json\n' + envelope + '\n```\nAfter', size, names) == 'Before\nAfter'


def test_non_json_braces_and_ordinary_code_arrive_before_closure():
    f = _FenceFilter()
    assert f.feed('Value $$x^{') == 'Value $$x^'
    assert f.feed('2}$$ continues.') == '{2}$$ continues.'
    f = _FenceFilter()
    assert f.feed('```python\nx = {') == '```python\nx = {'
    assert f.feed('a scientific value') == 'a scientific value'


def test_json_braces_inside_strings_are_not_object_boundaries():
    assert list(iter_json_objects('{"value":"} {","nested":{"x":1}}')) == [
        (0, 32, '{"value":"} {","nested":{"x":1}}')
    ]


def test_presentation_guidance_preserves_scientific_and_proposal_policies():
    assert PRESENTATION_GUIDANCE in _stable_system(False)
    assert 'NEVER write out or reproduce the actual governing equation' in _stable_system(False)
    assert PRESENTATION_GUIDANCE in _system_prompt({})
    assert 'Proposal action: create_experiment' in _system_prompt({})


def test_ordinary_labelled_code_is_not_recovered_as_a_tool():
    text = '```text\n{"name":"sample","arguments":"example"}\n```'
    assert _extract_text_tool_calls(text, {'sample'}, prefix='test') == (text, [])
