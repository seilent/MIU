#!/usr/bin/env python3
"""
Setup script for MIU Linux Client
"""

from setuptools import setup, find_packages
import os

# Read README if it exists
readme_path = os.path.join(os.path.dirname(__file__), 'README.md')
long_description = ''
if os.path.exists(readme_path):
    with open(readme_path, 'r', encoding='utf-8') as f:
        long_description = f.read()

setup(
    name='miu-linux-client',
    version='1.0.0',
    description='Lightweight Linux client for MIU music streaming',
    long_description=long_description,
    long_description_content_type='text/markdown',
    author='MIU Team',
    url='https://github.com/your-repo/miu',
    py_modules=['miu_client'],
    install_requires=[
        'pygame>=2.0.0',
        'Pillow>=8.0.0',
        'pystray>=0.17.0',
    ],
    entry_points={
        'console_scripts': [
            'miu-client=miu_client:main',
        ],
    },
    classifiers=[
        'Development Status :: 4 - Beta',
        'Intended Audience :: End Users/Desktop',
        'License :: OSI Approved :: MIT License',
        'Operating System :: POSIX :: Linux',
        'Programming Language :: Python :: 3',
        'Programming Language :: Python :: 3.8',
        'Programming Language :: Python :: 3.9',
        'Programming Language :: Python :: 3.10',
        'Programming Language :: Python :: 3.11',
        'Topic :: Multimedia :: Sound/Audio :: Players',
    ],
    python_requires='>=3.8',
    keywords='music audio streaming client linux',
)