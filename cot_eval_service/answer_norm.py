#!/usr/bin/env python3
r"""Answer-equivalence fallback for the solvability grader.

The repo's `utils.evaluate.answer_check` only reliably matches simple
integer/scalar answers; it scores rationalized radicals (2\sqrt5/5 vs 2/\sqrt5)
and tuple / "find-all" answers ((4,2), (2,5), p=5,q=3,r=19) as wrong even when
correct. `answers_equivalent` is used ONLY as a fallback when answer_check says
False, so it can rescue true positives without inventing new ones.

Pure-python + sympy; degrades to string/tuple compare if sympy is unavailable.
"""
import re

try:
    from sympy import N, simplify
    from sympy.parsing.sympy_parser import (
        implicit_multiplication_application, parse_expr, standard_transformations)
    _SYMPY = True
    _TRANSFORMS = standard_transformations + (implicit_multiplication_application,)
except Exception:  # noqa: BLE001
    _SYMPY = False


def extract_final_answer(response: str) -> str:
    r"""Contents of the last \boxed{...} in a model response (balanced braces)."""
    if not response:
        return ""
    key = "\\boxed"
    idx = response.rfind(key)
    if idx == -1:
        return ""
    i = idx + len(key)
    while i < len(response) and response[i] == " ":
        i += 1
    if i >= len(response) or response[i] != "{":
        return ""
    depth = 0
    start = i + 1
    for j in range(i, len(response)):
        if response[j] == "{":
            depth += 1
        elif response[j] == "}":
            depth -= 1
            if depth == 0:
                return response[start:j]
    return response[start:]


def _strip_latex(s: str) -> str:
    s = s.strip()
    s = s.replace("\\left", "").replace("\\right", "")
    s = re.sub(r"\\[,;!]", "", s)
    s = re.sub(r"\\text\{[^{}]*\}", "", s)
    s = re.sub(r"\\mathbb\{[^{}]*\}", "", s)
    s = s.replace("$", "").replace("\\(", "").replace("\\)", "")
    s = s.replace("\\[", "").replace("\\]", "")
    return s.strip().strip(".").strip()


def _read_group(s: str, i: int):
    """s[i] == '{'; return (inner_text, index_after_matching_close)."""
    depth = 0
    for j in range(i, len(s)):
        if s[j] == "{":
            depth += 1
        elif s[j] == "}":
            depth -= 1
            if depth == 0:
                return s[i + 1:j], j + 1
    return s[i + 1:], len(s)


def _convert_frac(s: str) -> str:
    r"""Convert \frac{a}{b} / \dfrac{a}{b} with balanced braces (handles nesting
    and braces from \sqrt inside the numerator, which a flat regex cannot)."""
    out = []
    i = 0
    while i < len(s):
        tag = None
        for t in ("\\dfrac", "\\frac"):
            if s.startswith(t, i):
                tag = t
                break
        if tag:
            j = i + len(tag)
            while j < len(s) and s[j] == " ":
                j += 1
            if j < len(s) and s[j] == "{":
                num, j = _read_group(s, j)
                while j < len(s) and s[j] == " ":
                    j += 1
                if j < len(s) and s[j] == "{":
                    den, j = _read_group(s, j)
                    out.append("((" + _convert_frac(num) + ")/(" + _convert_frac(den) + "))")
                    i = j
                    continue
        out.append(s[i])
        i += 1
    return "".join(out)


def _latex_to_sympy(s: str) -> str:
    s = _strip_latex(s)
    s = _convert_frac(s)  # balanced-brace \frac first, before braces become parens
    s = re.sub(r"\\sqrt\[([^\]]*)\]\{([^{}]*)\}", r"((\2)**(1/(\1)))", s)
    s = re.sub(r"\\sqrt\{([^{}]*)\}", r"sqrt(\1)", s)
    s = re.sub(r"\\sqrt\s*(\w+)", r"sqrt(\1)", s)
    s = s.replace("\\cdot", "*").replace("\\times", "*").replace("\\pi", "pi")
    s = s.replace("^", "**").replace("{", "(").replace("}", ")")
    s = s.replace("\\", "")
    return s.strip()


def _expr(s: str):
    return parse_expr(_latex_to_sympy(s), transformations=_TRANSFORMS, evaluate=True)


def scalar_equiv(a: str, b: str) -> bool:
    """True if a and b denote the same number (handles fractions, radicals)."""
    a, b = _strip_latex(a), _strip_latex(b)
    if a == b:
        return True
    if not _SYMPY:
        return False
    try:
        ea, eb = _expr(a), _expr(b)
        if simplify(ea - eb) == 0:
            return True
        return abs(float(N(ea)) - float(N(eb))) < 1e-9
    except Exception:  # noqa: BLE001
        return False


def _parse_multi(s: str):
    """Parse a 'find-all' answer into a frozenset of ordered tuples of scalar
    strings. Handles '(4,2)', '(x,y)=(4,2)', '(2,5),(5,2)', 'p=5,q=3,r=19'."""
    s = _strip_latex(s)
    groups = re.findall(r"\(([^()]*)\)", s)
    if groups:
        tuples = []
        for g in groups:
            parts = [p.strip() for p in g.split(",") if p.strip()]
            if parts and all(re.fullmatch(r"[a-zA-Z]\w*", p) for p in parts):
                continue  # drop a pure-variable label like (x,y) in (x,y)=(4,2)
            parts = [p.split("=")[-1].strip() for p in parts]
            if parts:
                tuples.append(tuple(parts))
        return frozenset(tuples)
    if "=" in s and "," in s:  # 'p=5,q=3,r=19' -> one tuple of the RHS values
        vals = [p.split("=")[-1].strip() for p in s.split(",") if "=" in p]
        if vals:
            return frozenset({tuple(vals)})
    return frozenset()


def _tuple_equiv(ta, tb) -> bool:
    if len(ta) != len(tb):
        return False
    return all(scalar_equiv(x, y) for x, y in zip(ta, tb))


def multi_equiv(a: str, b: str) -> bool:
    """Same set of tuples (order within a tuple matters, order between tuples not)."""
    sa, sb = _parse_multi(a), _parse_multi(b)
    if not sa or not sb or len(sa) != len(sb):
        return False
    unmatched = list(sb)
    for ta in sa:
        hit = next((i for i, tb in enumerate(unmatched) if _tuple_equiv(ta, tb)), None)
        if hit is None:
            return False
        unmatched.pop(hit)
    return True


def answers_equivalent(model_ans: str, gt: str) -> bool:
    """Fallback equivalence: scalar first, then multi/tuple."""
    if not model_ans or not gt:
        return False
    return scalar_equiv(model_ans, gt) or multi_equiv(model_ans, gt)
