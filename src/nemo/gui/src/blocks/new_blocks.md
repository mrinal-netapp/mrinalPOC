
# DataPipeline Blocks

New blocks for the Data pipline, the blocks help in processing data captured in dataframes.

1. Dataset Reader - Reader block is used to read data from Dataset as DataFrames.
    1. Handles - 1 input handle and 1 output handle.
    2. Input Handle type : any
    3. Output handle type: Dataframe
    4. Parameters / fields
        1. Dataset id - user chooses from the known datasets
2. Filter - Filters records from input DataFrame to output
    1. Handles - 1 input handle and 1 output handle.
    2. Input Handle type : DataFrame
    3. Output handle type: Dataframe
    4. Parameters / fields
        1. filter - an expression that act on dataframe. The expression are typically python expression syntax
        2. on_error - include/exclude
3. Join - Join 2 DataFrames to output a single joined DataFrame
    1. Handles - 2 input handles and 1 output handle.
    2. Input Handle types : A - DataFrame, B - DataFrame
    3. Output handle type: Dataframe
    4. Parameters / fields
        1. join_fields - identify a join field from input A and B
        2. join_type - equal / left / right
4. GroupBy_Agg - Group records of a DataFrame and compute aggregate values by group
    1. Handles - 1 input handles and 1 output handle.
    2. Input Handle types : DataFrame
    3. Output handle type: Dataframe
    4. Parameters / fields
        1. group_by - field name to group by
        2. aggregates - Map of alias name to aggregation expressions
            1. alias name is a string
            2. aggregate function - typical aggregate functions like sum, count, min, max, etc,
                1. the aggregate function may also take a parameter of what to aggregate - an expression
5. ApplyFunc - Apply a function to every record in the DataFrame
    1. Handles - 1 input handles and 1 output handle.
    2. Input Handle types : DataFrame
    3. Output handle type: Dataframe
    4. Parameters / fields
        1. function - text field that takes a Python function operating on a DataFrame
6. Dataset Writer - Writer block is used to write / serialize a DataFrame into a parquet files in a DataSet
    1. Handles - 1 input handle.
    2. Input Handle type : DataFrame
    3. Parameters / fields
        1. Dataset id - user chooses from the known datasets
        2. write_mode - possible values append / new_version



