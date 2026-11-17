"""离线运行环境验收：使用真实计算与文件往返，禁止任何网络连接。"""
import importlib
import json
import socket
import sqlite3

import pytest


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def denied(*_args, **_kwargs):
        raise AssertionError("离线分析不允许网络访问")

    monkeypatch.setattr(socket, "create_connection", denied)
    monkeypatch.setattr(socket.socket, "connect", denied)
    monkeypatch.setattr(socket.socket, "connect_ex", denied)
    monkeypatch.setattr(socket, "getaddrinfo", denied)


def test_all_declared_analysis_modules_import_without_network():
    for name in [
        "numpy", "pandas", "polars", "duckdb", "pyarrow", "scipy", "statsmodels.api",
        "sklearn", "sympy", "matplotlib", "seaborn", "plotly", "PIL", "openpyxl",
        "xlsxwriter", "xlrd", "pyxlsb", "python_calamine", "odf", "orjson", "yaml",
        "lxml", "bs4", "defusedxml", "docx", "pptx", "pypdf", "reportlab", "sqlalchemy",
        "sqlglot", "sqlparse", "psycopg", "pymysql", "sqlite_utils", "dateutil", "pytz",
        "babel", "pint", "rapidfuzz", "tabulate", "rich", "networkx", "chardet",
        "charset_normalizer", "hypothesis",
    ]:
        importlib.import_module(name)


def test_clean_join_aggregate_and_sql_agree():
    import duckdb
    import pandas as pd
    import polars as pl

    sales = pd.DataFrame({"customer": ["A", "B", "A", "C"], "amount": [10, 20, None, 30]})
    groups = pd.DataFrame({"customer": ["A", "B", "C"], "region": ["east", "west", "east"]})
    joined = sales.dropna().merge(groups, on="customer", validate="many_to_one")
    expected = {"east": 40.0, "west": 20.0}
    assert joined.groupby("region")["amount"].sum().to_dict() == expected
    with duckdb.connect(":memory:") as connection:
        connection.register("joined", joined)
        result = connection.execute("SELECT region, sum(amount) AS total FROM joined GROUP BY region").fetchall()
    assert dict(result) == expected
    assert dict(pl.from_pandas(joined).group_by("region").agg(pl.col("amount").sum()).iter_rows()) == expected


def test_csv_excel_parquet_json_preserve_values_and_nulls(tmp_path):
    import pandas as pd
    import pyarrow.parquet as pq

    frame = pd.DataFrame({"label": ["中文", "ordinary", "third"], "value": [1.5, None, 3.25]})
    frame.to_csv(tmp_path / "data.csv", index=False)
    frame.to_excel(tmp_path / "data.xlsx", index=False, engine="xlsxwriter")
    frame.to_parquet(tmp_path / "data.parquet", index=False)
    frame.to_json(tmp_path / "data.json", orient="records", force_ascii=False)
    for output in [pd.read_csv(tmp_path / "data.csv"), pd.read_excel(tmp_path / "data.xlsx"), pd.read_parquet(tmp_path / "data.parquet")]:
        pd.testing.assert_frame_equal(output, frame)
    assert pq.read_table(tmp_path / "data.parquet").num_rows == 3
    assert json.loads((tmp_path / "data.json").read_text())[1]["value"] is None


def test_statistics_regression_symbolic_and_units():
    import numpy as np
    import pint
    import scipy.stats as stats
    import statsmodels.api as sm
    import sympy
    from sklearn.linear_model import LinearRegression

    x = np.arange(1, 6, dtype=float)
    y = 2 * x + 3
    np.testing.assert_allclose(sm.OLS(y, sm.add_constant(x)).fit().params, [3, 2])
    assert LinearRegression().fit(x.reshape(-1, 1), y).coef_[0] == pytest.approx(2)
    assert stats.pearsonr(x, y).statistic == pytest.approx(1)
    symbol = sympy.Symbol("x")
    assert sympy.solve(2 * symbol + 3 - 13, symbol) == [5]
    assert pint.UnitRegistry().Quantity(1, "kilometer").to("meter").magnitude == 1000


def test_headless_static_and_standalone_interactive_charts(tmp_path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import plotly.graph_objects as go
    from PIL import Image

    figure, axis = plt.subplots()
    axis.plot([1, 2, 3], [2, 4, 6])
    figure.savefig(tmp_path / "chart.png")
    figure.savefig(tmp_path / "chart.svg")
    plt.close(figure)
    with Image.open(tmp_path / "chart.png") as image:
        assert image.width >= 600 and image.height >= 400
    assert "<svg" in (tmp_path / "chart.svg").read_text()
    go.Figure(go.Bar(x=["east", "west"], y=[40, 20])).write_html(tmp_path / "chart.html", include_plotlyjs=True)
    html = (tmp_path / "chart.html").read_text()
    assert "Plotly.newPlot" in html
    assert '<script src="https://' not in html


def test_sql_parsing_and_local_sqlite_need_no_server(tmp_path):
    import sqlglot
    from sqlalchemy import create_engine, text

    query = sqlglot.parse_one("SELECT region, SUM(amount) AS total FROM sales GROUP BY region", dialect="postgres")
    assert "SUM" in query.sql(dialect="duckdb")
    with sqlite3.connect(tmp_path / "analysis.db") as connection:
        connection.execute("CREATE TABLE sales (amount REAL)")
        connection.executemany("INSERT INTO sales VALUES (?)", [(10,), (20,)])
        assert connection.execute("SELECT sum(amount) FROM sales").fetchone()[0] == 30
    engine = create_engine("sqlite://")
    with engine.connect() as connection:
        assert connection.execute(text("SELECT 6 * 7")).scalar_one() == 42
