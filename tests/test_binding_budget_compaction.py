"""Regression: compact only redundant public aliases, never commercial gates."""
import ast
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/deploy/prepare-central-candidate.py"

class BindingBudgetAliasTest(unittest.TestCase):
    def test_compacted_release_and_contact_values_remain_accessible(self):
        source = ast.parse(SCRIPT.read_text(encoding="utf-8"))
        loops = [node for node in source.body if isinstance(node, ast.For)
                 and isinstance(node.target, ast.Name) and node.target.id == "key"
                 and isinstance(node.iter, ast.Tuple)
                 and [n.value for n in node.iter.elts if isinstance(n, ast.Constant)] ==
                 ["ZEVANORY_RELEASE_REF", "ZEVANORY_WHATSAPP_DISPLAY"]]
        self.assertEqual(len(loops), 1, "expected the explicit safe compaction loop")
        before = {"ZEVANORY_RELEASE_REF": "gh-pages",
                  "ZEVANORY_WHATSAPP_DISPLAY": "+55 88 99254-5413",
                  "SALE_GLOBALLY_ENABLED": "false",
                  "MERCADOPAGO_ENV": "production",
                  "PRE_SALE_GATES_APPROVED": "false"}
        c = {"vars": dict(before)}
        runtime_config = {}
        compiled = compile(ast.fix_missing_locations(ast.Module(body=loops, type_ignores=[])), str(SCRIPT), "exec")
        exec(compiled, {"c": c, "runtime_config": runtime_config})
        self.assertEqual(runtime_config, {k: before[k] for k in
                         ("ZEVANORY_RELEASE_REF", "ZEVANORY_WHATSAPP_DISPLAY")})
        self.assertEqual(set(before) - set(c["vars"]), set(runtime_config))
        for gate in ("SALE_GLOBALLY_ENABLED", "MERCADOPAGO_ENV", "PRE_SALE_GATES_APPROVED"):
            self.assertEqual(c["vars"][gate], before[gate])

if __name__ == "__main__":
    unittest.main()
